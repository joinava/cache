import { maxBy } from "es-toolkit";
import { fileURLToPath } from "node:url";
import { Piscina } from "piscina";
import type {
  DateString,
  Jsonify,
  JsonOf,
  JSONWithUndefined,
  NonEmptyArray,
} from "type-party";
import { parseDateString } from "type-party/runtime/dates.js";
import { jsonParse, jsonStringify } from "type-party/runtime/json.js";

import type { CacheSpec, SpecForId } from "../../types/00_CacheSpec.js";
import type { AnyParams } from "../../types/01_Params.js";
import type { AnyValidators } from "../../types/02_Validators.js";
import type {
  Entry,
  JsonifiedEntry,
  NormalizedParams,
  NormalizedVary,
} from "../../types/06_Normalization.js";
import type { StoreGetManyResult } from "../../types/06_Store.js";
import type {
  EntryForId,
  Logger,
  Store,
  StoreEntryInput,
  StoreGetManyRequest,
  Vary,
} from "../../types/index.js";
import { restoreInfinityInDirectives } from "../../utils/normalization.js";
import { birthDate } from "../../utils/normalizedProducerResultResourceHelpers.js";
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

type AsNonEmptyArray<T extends readonly unknown[]> = T extends (infer U)[]
  ? NonEmptyArray<U>
  : never;

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
> implements Store<Spec, Validators, Params> {
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

  public async get<Id extends Spec["id"]>(
    id: Id,
    params: Readonly<NormalizedParams<Params>>,
    options?: { signal?: AbortSignal },
  ): Promise<EntryForId<Spec, Validators, Params, Id>[]> {
    options?.signal?.throwIfAborted();

    const entries = await this.#read({
      type: "get",
      id,
      params,
    });

    options?.signal?.throwIfAborted();
    this.#scheduleLazyCleanup();
    return entries.map((entry) => this.#deserializeEntry<Id>(entry));
  }

  public async getMany<
    const Reqs extends readonly StoreGetManyRequest<Spec, Params>[],
  >(
    requests: Reqs,
    options?: { signal?: AbortSignal },
  ): Promise<StoreGetManyResult<Spec, Reqs, Validators, Params>> {
    options?.signal?.throwIfAborted();

    const entries = await this.#read({
      type: "getMany",
      requests: requests.map(({ id, params }) => ({ id, params })),
    });

    options?.signal?.throwIfAborted();
    this.#scheduleLazyCleanup();
    return entries.map((requestEntries) =>
      requestEntries.map((entry) => this.#deserializeEntry<Spec["id"]>(entry)),
    ) satisfies EntryForId<Spec, Validators, Params, Spec["id"]>[][] as {
      -readonly [K in keyof Reqs]: EntryForId<
        Spec,
        Validators,
        Params,
        Reqs[K]["id"]
      >[];
    };
  }

  public async store(
    entries: readonly StoreEntryInput<Spec, Validators, Params>[],
  ): Promise<void> {
    if (this.#status !== "open") {
      throw new Error("SqliteStore is closed");
    }
    if (entries.length === 0) return;

    await this.#write({
      type: "store",
      entries: this.#prepareEntries(entries),
    });
  }

  public async delete(id: Spec["id"]): Promise<void> {
    await this.#write({ type: "delete", id });
  }

  public async close(timeout?: number): Promise<void> {
    this.#closePromise ??= this.#closeGracefully();

    return timeout === undefined
      ? this.#closePromise
      : withTimeout(this.#closePromise, timeout, async () => {
          this.#status = "closed";
          await Promise.all([
            this.#writerPool.destroy(),
            this.#readPool.destroy(),
          ]);
        });
  }

  async #closeGracefully(): Promise<void> {
    if (this.#status === "closed") return;
    this.#status = "closing";
    let readPoolClosed = false;
    let writerPoolClosed = false;
    let closeError: unknown;

    try {
      try {
        // Piscina does not expose a worker shutdown hook that it awaits. Read
        // connections are released when Piscina terminates the read workers; the
        // writer is closed explicitly below because it must checkpoint the WAL.
        await this.#readPool.close();
        readPoolClosed = true;
      } catch (error) {
        closeError = error;
      }

      try {
        await this.#write(
          { type: "close", checkpoint: true },
          { allowWhenClosing: true },
        );
        await this.#writerPool.close();
        writerPoolClosed = true;
      } catch (error) {
        closeError ??= error;
      }

      if (closeError !== undefined) {
        throw closeError;
      }
    } finally {
      this.#status = "closed";
      await Promise.all([
        writerPoolClosed ? Promise.resolve() : this.#writerPool.destroy(),
        readPoolClosed ? Promise.resolve() : this.#readPool.destroy(),
      ]);
    }
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    return this.close(60_000);
  }

  #prepareEntries(
    entries: readonly StoreEntryInput<Spec, Validators, Params>[],
  ): WorkerStoreEntryInput[] {
    return Map.groupBy(entries, ({ entry }) =>
      jsonStringify([entry.id, resultVariantKey(entry.vary)]),
    )
      .values()
      .map((sameVariantEntries) => {
        const newestForVariant = maxBy(
          // groupBy guarantees that the array is non-empty
          sameVariantEntries as AsNonEmptyArray<typeof sameVariantEntries>,
          ({ entry }) => birthDate(entry).valueOf(),
        );

        const { entry, maxStoreForSeconds } = newestForVariant;
        return this.#prepareEntry(entry, maxStoreForSeconds);
      })
      .toArray();
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

    return {
      id: _.id,
      content: _.content,
      vary: _.vary satisfies Vary<AnyParams> as NormalizedVary<Params>,
      validators: _.validators satisfies AnyValidators as Partial<Validators>,
      directives: restoreInfinityInDirectives(_.directives),
      initialAge: _.initialAge,
      date: parseDateString(_.date satisfies string as DateString),
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

    return this.#writerPool.run(message) as Promise<
      WorkerResultForRequest<Message>
    >;
  }

  #read<const Message extends ReadWorkerRequestInput>(
    message: Message,
  ): Promise<WorkerResultForRequest<Message>> {
    if (this.#status !== "open") {
      return Promise.reject(new Error("SqliteStore is closed"));
    }

    return this.#readPool.run(message) as Promise<
      WorkerResultForRequest<Message>
    >;
  }
}

const noopLogger: Logger = () => {};

function withTimeout(
  promise: Promise<void>,
  timeoutMs: number,
  onTimeout: () => Promise<void>,
): Promise<void> {
  if (!Number.isFinite(timeoutMs)) return promise;
  if (timeoutMs < 0) {
    return Promise.reject(
      new Error("SqliteStore close timeout must be non-negative"),
    );
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      void onTimeout().then(() => {
        reject(new Error(`SqliteStore close timed out after ${timeoutMs}ms`));
      }, reject);
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  });
}
