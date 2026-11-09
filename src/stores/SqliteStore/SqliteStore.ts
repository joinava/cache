import { fileURLToPath } from "node:url";
import { Piscina } from "piscina";
import type {
  DateString,
  Jsonify,
  JsonOf,
  JSONWithUndefined,
} from "type-party";
import { parseDateString } from "type-party/runtime/dates.js";
import { jsonParse, jsonStringify } from "type-party/runtime/json.js";

import type { CacheSpec, SpecForId } from "../../types/00_CacheSpec.js";
import type { AnyParams } from "../../types/01_Params.js";
import type { AnyValidators } from "../../types/02_Validators.js";
import type {
  Entry,
  JsonifiedEntry,
  NormalizedVary,
} from "../../types/06_Normalization.js";
import type {
  StoreOperations,
  BulkStoreReader,
  StoreEntryResult,
  StoreGetManyResult,
} from "../../types/06_Store.js";
import type {
  EntryForId,
  Logger,
  StoreEntryInput,
  StoreGetManyRequest,
  Vary,
} from "../../types/index.js";
import { restoreInfinityInDirectives } from "../../utils/normalization.js";
import { birthDate } from "../../utils/normalizedProducerResultResourceHelpers.js";
import {
  asError,
  CacheContractError,
  keepMaxPerGroup,
} from "../../utils/utils.js";
import { resultVariantKey } from "../../utils/varyHelpers.js";
import type {
  ReadWorkerRequestInput,
  WorkerEntryJson,
  WorkerInitData,
  WorkerResultForRequest,
  StoreEntryInput as WorkerStoreEntryInput,
  WriteWorkerRequestInput,
} from "./SqliteStore.worker.js";

export type SqliteStoreCompatibleSpec = CacheSpec<string, JSONWithUndefined>;
export type SqliteStoreSupportedParams = {
  [paramName: string]: string | number | boolean | undefined;
};

const LAZY_CLEANUP_INTERVAL_MS = 60_000;

type TableEntry<
  Spec extends SqliteStoreCompatibleSpec,
  Validators extends AnyValidators,
  Params extends SqliteStoreSupportedParams,
  Id extends Spec["id"] = Spec["id"],
> = JsonifiedEntry<SpecForId<Spec, Id>, Validators, Params>;

/**
 * A {@link Store} backed by a single SQLite database file.
 *
 * SQLite runs in a dedicated worker thread via Node's built-in `node:sqlite`
 * module. Writes are serialized through one worker, while reads use a worker
 * pool. The persisted database file is intended to be portable as one cache
 * artifact once `close()` has resolved.
 */
export default class SqliteStore<
  Spec extends SqliteStoreCompatibleSpec = SqliteStoreCompatibleSpec,
  Validators extends AnyValidators = AnyValidators,
  Params extends SqliteStoreSupportedParams = SqliteStoreSupportedParams,
>
  implements
    StoreOperations<Spec, Validators, Params>,
    BulkStoreReader<Spec, Validators, Params>
{
  readonly #fallbackDeleteAfter: number;
  readonly #log: Logger;
  readonly #writerPool: Piscina<
    WriteWorkerRequestInput,
    WorkerResultForRequest<WriteWorkerRequestInput>
  >;
  readonly #readPool: Piscina<
    ReadWorkerRequestInput,
    WorkerResultForRequest<ReadWorkerRequestInput>
  >;

  readonly #pending = new Set<Promise<unknown>>();
  #status: "open" | "closing" | "closed" = "open";
  #closePromise: Promise<void> | undefined;
  #lazyCleanupPromise: Promise<void> | undefined;
  #lastLazyCleanupAt = 0;

  public constructor(opts: {
    databasePath: string;
    fallbackDeleteAfter?: number;
    busyTimeoutMs?: number;
    readWorkerCount?: number;
    logger?: Logger;
  }) {
    this.#fallbackDeleteAfter = opts.fallbackDeleteAfter ?? 30 * 24 * 60 * 60;

    const log: Logger = opts.logger ?? noopLogger;
    this.#log = log;
    const logPoolError = (poolName: "reader" | "writer", error: unknown) => {
      log(
        "sqlite-store",
        "warn",
        `SqliteStore ${poolName} worker pool emitted an out-of-band error`,
        { error },
      );
    };

    const baseWorkerData = {
      databasePath: opts.databasePath,
      busyTimeoutMs: opts.busyTimeoutMs ?? 5000,
    };

    const workerFilename = fileURLToPath(
      new URL("./SqliteStore.worker.js", import.meta.url),
    );

    this.#writerPool = new Piscina({
      filename: workerFilename,
      minThreads: 1,
      maxThreads: 1,
      workerData: {
        ...baseWorkerData,
        role: "writer",
      } satisfies WorkerInitData,
    });

    const readWorkerCount = Math.max(1, opts.readWorkerCount ?? 2);
    this.#readPool = new Piscina({
      filename: workerFilename,
      minThreads: 0,
      maxThreads: readWorkerCount,
      idleTimeout: 30_000,
      workerData: {
        ...baseWorkerData,
        role: "reader",
      } satisfies WorkerInitData,
    });

    this.#writerPool.on("error", (error) => {
      logPoolError("writer", error);
    });

    this.#readPool.on("error", (error) => {
      logPoolError("reader", error);
    });
  }

  public async getMany<
    const Reqs extends readonly StoreGetManyRequest<Spec, Params>[],
  >(
    requests: Reqs,
    options?: { signal?: AbortSignal },
  ): Promise<StoreGetManyResult<Spec, Reqs, Validators, Params>> {
    options?.signal?.throwIfAborted();

    if (requests.length === 0)
      return [] as StoreGetManyResult<Spec, Reqs, Validators, Params>;
    const cancelled = new Int32Array(
      new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    );
    const onAbort = () => Atomics.store(cancelled, 0, 1);
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const entries = await this.#read({
        type: "getMany",
        requests: requests.map(({ id, params }) => ({ id, params })),
        cancelled,
      });
      options?.signal?.throwIfAborted();
      if (entries.length !== requests.length)
        throw new CacheContractError("SQLite returned an invalid result count");
      this.#scheduleLazyCleanup();
      return entries.map((requestEntries, index) => {
        if (requestEntries instanceof Error) return requestEntries;
        try {
          // Check persisted IDs because SQL text binding can replace lone surrogates.
          return requestEntries
            .map((entry) => this.#deserializeEntry<Spec["id"]>(entry))
            .filter((entry) => entry.id === requests[index]!.id);
        } catch (failure) {
          return asError(failure);
        }
      }) as StoreGetManyResult<Spec, Reqs, Validators, Params>;
    } catch (error) {
      options?.signal?.throwIfAborted();
      throw error;
    } finally {
      options?.signal?.removeEventListener("abort", onAbort);
    }
  }

  public async store(
    entries: readonly StoreEntryInput<Spec, Validators, Params>[],
  ): Promise<readonly StoreEntryResult[]> {
    if (this.#status !== "open") {
      throw new Error("SqliteStore is closed");
    }
    if (entries.length === 0) return [];

    // Entries are deduped per slot before being sent to the worker (keeping the
    // newest birth date), so the worker's per-entry results are parallel to the
    // deduped list. Map those back onto the original input order; entries
    // dropped by dedup report `{}`.
    const prepared = this.#prepareEntries(entries);
    const workerResults = await this.#write({
      type: "store",
      entries: prepared.map((it) => it.workerEntry),
    });

    const results: StoreEntryResult[] = entries.map(() => ({}));
    prepared.forEach((it, i) => {
      results[it.originalIndex] = workerResults[i] ?? {};
    });
    return results;
  }

  public async delete(id: Spec["id"]): Promise<void> {
    await this.#write({ type: "delete", id });
  }

  public close(): Promise<void> {
    this.#closePromise ??= this.#closeGracefully();
    return this.#closePromise;
  }

  async #closeGracefully(): Promise<void> {
    this.#status = "closing";
    // Drain first: Piscina.close has an implicit deadline and may abandon work.
    await Promise.allSettled(this.#pending);
    const failures: unknown[] = [];
    try {
      await this.#write(
        { type: "close", checkpoint: true },
        { allowWhenClosing: true },
      );
    } catch (error) {
      failures.push(error);
    }
    // No accepted tasks remain. Termination releases every read connection.
    const pools = await Promise.allSettled([
      this.#readPool.destroy(),
      this.#writerPool.destroy(),
    ]);
    pools.forEach((result) => {
      if (result.status === "rejected") failures.push(result.reason);
    });
    this.#status = "closed";
    if (failures.length > 0)
      throw new AggregateError(failures, "SQLite cleanup failed");
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  #track<T>(pending: Promise<T>): Promise<T> {
    this.#pending.add(pending);
    void pending.then(
      () => this.#pending.delete(pending),
      () => this.#pending.delete(pending),
    );
    return pending;
  }

  #prepareEntries(
    entries: readonly StoreEntryInput<Spec, Validators, Params>[],
  ): { workerEntry: WorkerStoreEntryInput; originalIndex: number }[] {
    return keepMaxPerGroup({
      items: entries.map((it, originalIndex) => ({ it, originalIndex })),
      groupBy: ({ it: { entry } }) =>
        jsonStringify([entry.id, resultVariantKey(entry.vary)]),
      maxBy: ({ it: { entry } }) => birthDate(entry).valueOf(),
    }).map(({ it: { entry, maxStoreForSeconds }, originalIndex }) => ({
      workerEntry: this.#prepareEntry(entry, maxStoreForSeconds),
      originalIndex,
    }));
  }

  #prepareEntry(
    entry: Entry<Spec, Validators, Params>,
    maxStoreForSeconds: number,
  ): WorkerStoreEntryInput {
    const finalDeleteAfterSeconds =
      maxStoreForSeconds === Infinity
        ? this.#fallbackDeleteAfter
        : maxStoreForSeconds;
    const expiresAt =
      finalDeleteAfterSeconds === Infinity
        ? null
        : Date.now() + finalDeleteAfterSeconds * 1000;
    const variantKey = resultVariantKey(entry.vary);

    return {
      resourceId: entry.id,
      variantKey,
      vary: entry.vary,
      entryJson: this.#serializeEntry(entry),
      expiresAt,
    };
  }

  #serializeEntry(entry: Entry<Spec, Validators, Params>): WorkerEntryJson {
    const serialized = jsonStringify(entry) satisfies
      | JsonOf<Jsonify<Entry<Spec, Validators, Params>>>
      | undefined as JsonOf<TableEntry<Spec, Validators, Params>> | undefined;

    if (serialized === undefined) {
      throw new Error("Could not serialize cache entry for SqliteStore");
    }

    return serialized satisfies JsonOf<
      TableEntry<Spec, Validators, Params>
    > as unknown as WorkerEntryJson;
  }

  #deserializeEntry<Id extends Spec["id"]>(
    entry: WorkerEntryJson,
  ): EntryForId<Spec, Validators, Params, Id> {
    const parsed = jsonParse(
      entry as unknown as JsonOf<TableEntry<Spec, Validators, Params, Id>>,
    );
    const _ = parsed satisfies TableEntry<
      Spec,
      Validators,
      Params,
      Id
    > as unknown as JsonifiedEntry<
      SqliteStoreCompatibleSpec,
      AnyValidators,
      AnyParams
    >;

    const date = parseDateString(_.date satisfies string as DateString);
    if (!Number.isFinite(date.getTime()))
      throw new Error("Invalid cached entry date");
    return {
      id: _.id,
      content: _.content,
      vary: _.vary satisfies Vary<AnyParams> as NormalizedVary<Params>,
      validators: _.validators satisfies AnyValidators as Partial<Validators>,
      directives: restoreInfinityInDirectives(_.directives),
      initialAge: _.initialAge,
      date,
    } satisfies Entry<
      SqliteStoreCompatibleSpec,
      Validators,
      Params
    > as EntryForId<Spec, Validators, Params, Id>;
  }

  #scheduleLazyCleanup(): void {
    if (this.#status !== "open" || this.#lazyCleanupPromise !== undefined) {
      return;
    }

    const now = Date.now();
    if (now - this.#lastLazyCleanupAt < LAZY_CLEANUP_INTERVAL_MS) {
      return;
    }
    this.#lastLazyCleanupAt = now;

    const cleanupPromise = this.#write({ type: "deleteExpired" })
      .catch((error: unknown) => {
        this.#log("sqlite-store", "warn", "SqliteStore lazy cleanup failed", {
          error,
        });
      })
      .finally(() => {
        if (this.#lazyCleanupPromise === cleanupPromise) {
          this.#lazyCleanupPromise = undefined;
        }
      });
    this.#lazyCleanupPromise = cleanupPromise;
  }

  #write<const Message extends WriteWorkerRequestInput>(
    message: Message,
    opts?: { allowWhenClosing?: boolean },
  ): Promise<WorkerResultForRequest<Message>> {
    if (
      this.#status === "closed" ||
      (this.#status === "closing" && opts?.allowWhenClosing !== true)
    ) {
      return Promise.reject(new Error("SqliteStore is closed"));
    }

    return this.#track(this.#writerPool.run(message)) as Promise<
      WorkerResultForRequest<Message>
    >;
  }

  #read<const Message extends ReadWorkerRequestInput>(
    message: Message,
  ): Promise<WorkerResultForRequest<Message>> {
    if (this.#status !== "open") {
      return Promise.reject(new Error("SqliteStore is closed"));
    }

    return this.#track(this.#readPool.run(message)) as Promise<
      WorkerResultForRequest<Message>
    >;
  }
}

const noopLogger: Logger = () => {};
