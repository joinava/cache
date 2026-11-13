import { chunk, groupBy, partition } from "es-toolkit";
import {
  timeSlicedSort,
  timeSlicedMap,
  timeSlicedForEach,
} from "@zingage/scheduling";
import type { ColumnType, PostgresPool, RawBuilder, SqlBool } from "kysely";
import { Kysely, PostgresDialect, sql } from "kysely";
import type { Tagged } from "type-fest";
import type {
  DateString,
  Jsonify,
  JsonOf,
  JSONWithUndefined,
} from "type-party";
import { parseDateString } from "type-party/runtime/dates.js";
import { entryUtils } from "../../index.js";
import type { CacheSpec, SpecForId } from "../../types/00_CacheSpec.js";
import type { AnyParams } from "../../types/01_Params.js";
import type { AnyValidators } from "../../types/02_Validators.js";
import type {
  Entry,
  JsonifiedEntry,
  NormalizedVary,
} from "../../types/06_Normalization.js";
import type {
  StoreEntryResult,
  StoreOperations,
  BulkStoreReader,
  StoreGetManyResult,
} from "../../types/06_Store.js";
import type {
  EntryForId,
  Logger,
  StoreEntryInput,
  StoreGetManyRequest,
  Vary,
} from "../../types/index.js";
import type { Bind2 } from "../../types/utils.js";
import { restoreInfinityInDirectives } from "../../utils/normalization.js";
import {
  validatorsAsStored,
  validatorsEqual,
} from "../../utils/normalizedProducerResultResourceHelpers.js";
import {
  asError,
  CacheContractError,
  defaultLoggersByComponent,
  jsonStringify,
  keepMaxPerGroupCooperatively,
} from "../../utils/utils.js";

/** Three parameters per request: index, ID, and JSONB params. */
const MAX_REQUESTS_PER_GET_MANY_QUERY = 1_000;

/**
 * Type representing the qualified name of the cache table.
 */
type CacheTableName = Tagged<string, "CacheTableName">;

/**
 * Type representing the entry in the cache table. It's basically the same as
 * the Entry type, but the date is a string since that's what it ends up as
 * after roundtripping through JSON.
 */
type TableEntry<
  Spec extends PostgresStoreCompatibleSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
  Id extends Spec["id"] = Spec["id"],
> = JsonifiedEntry<SpecForId<Spec, Id>, Validators, Params>;

type CacheTables<
  Spec extends PostgresStoreCompatibleSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = {
  [key in CacheTableName]: {
    // TODO: should be <Id, Id, never>, but kysely looses the tag at some point.
    resource_id: ColumnType<string, string, never>;
    // Select type is `NormalizedVary` (not `NormalizedParams`) because the
    // stored value can carry `null` values -- a `null` vary value means "this
    // variant applies only when the request omits that param".
    vary: ColumnType<
      Readonly<NormalizedVary<Params>>,
      JsonOf<NormalizedVary<Params>>,
      never
    >;
    entry: ColumnType<
      TableEntry<Spec, Validators, Params>,
      JsonOf<TableEntry<Spec, Validators, Params>>,
      JsonOf<TableEntry<Spec, Validators, Params>>
    >;
  };
};

/**
 * We restrict the params this store supports to _primitive_ values.
 *
 * Both read paths use `varyMatchesParamsSql`: non-null vary values require
 * JSONB equality, and null requires an absent param. Primitive params keep
 * the same matching contract as the Memory and SQLite stores.
 *
 * A previous implementation matched via the JSONB containment operator
 * (`vary <@ $params`). It was replaced because containment cannot express the
 * `null`-vary rule -- `<@` requires the key to be *present* with an equal
 * value, so `{"format": null}` never matched a request that omitted `format` --
 * and because it matched partially-contained nested objects rather than
 * requiring exact equality.
 */
export type PostgresStoreSupportedParams = {
  [paramName: string]: string | number | boolean | undefined;
};

/**
 * The constraint that PostgresStore places on a `Spec`'s `content`: must be
 * JSON-serializable (potentially with undefined values present, since those
 * are stripped on serialization).
 */
export type PostgresStoreCompatibleSpec = CacheSpec<string, JSONWithUndefined>;

/**
 * Builds the SQL predicate that keeps only the stored variants (rows) whose
 * `vary` requirements are satisfied by a request's `params`, implementing the
 * full matching contract in the database.
 *
 * A row matches iff *no* vary entry is violated. For each `(key, value)` in the
 * row's `vary`:
 *   - a `null` value means "the param must be *absent*", so it's violated when
 *     `params` contains that key; and
 *   - a non-null value must `jsonb`-equal `params -> key` (which is SQL `NULL`,
 *     hence `IS DISTINCT FROM`, when the param is missing).
 *
 * Both arguments are SQL expressions, so bulk reads can reference a joined
 * request's params. Empty vary matches every request, so an equality guard
 * skips the jsonb_each scan for that common case. Other candidates still
 * require scanning their vary requirements. We use
 * the `jsonb_exists` function rather than the `?` operator because `?` is
 * ambiguous with driver parameter placeholders.
 */
function varyMatchesParamsSql(
  vary: RawBuilder<unknown>,
  params: RawBuilder<unknown>,
): RawBuilder<SqlBool> {
  return sql<SqlBool>`(${vary} = '{}'::jsonb or not exists (
    select 1
    from jsonb_each(${vary}) as v(key, value)
    where case
      when jsonb_typeof(v.value) = 'null' then jsonb_exists(${params}, v.key)
      else (${params} -> v.key) is distinct from v.value
    end
  ))`;
}

/**
 * This class implements a store for cache entries, backed by Postgres. For
 * details on each method, see the Store interface.
 *
 * Each row in the table is a separate cache entry, uniquely identified by
 * (resourceId, vary) pair. Each of these rows stores the id (string), vary
 * (jsonb), and a full entry (jsonb).
 *
 * Reads narrow candidates by resource_id and evaluate vary requirements in
 * Postgres, transferring only matching entry payloads.
 *
 * `getMany` reads up to {@link MAX_REQUESTS_PER_GET_MANY_QUERY} requests in one
 * round trip (see its docs). Cache accumulates scalar reads into this bulk
 * primitive by default. Larger request sets use sequential SQL chunks.
 */
export default class PostgresStore<
  Spec extends PostgresStoreCompatibleSpec = PostgresStoreCompatibleSpec,
  Validators extends AnyValidators = AnyValidators,
  Params extends PostgresStoreSupportedParams = PostgresStoreSupportedParams,
>
  implements
    StoreOperations<Spec, Validators, Params>,
    BulkStoreReader<Spec, Validators, Params>
{
  /** Object containing info about the schema and table name */
  private readonly tableNameData: {
    schemaName: string;
    tableName: string;
    qualifiedName: CacheTableName;
  };
  private readonly db: Kysely<CacheTables<Spec, Validators, Params>>;
  /** Promise that resolves when the required tables are initialized */
  private ensureInitializedPromise: Promise<void>;

  private readonly logInfo: Bind2<Logger, "postgres-store", "info">;
  private readonly logTrace: Bind2<Logger, "postgres-store", "trace">;
  private readonly logError: Bind2<Logger, "postgres-store", "error">;
  private readonly logWarn: Bind2<Logger, "postgres-store", "warn">;

  /**
   * @param pool - The postgres pool to use. Typed as Kysely's structural
   *  `PostgresPool` rather than `pg`'s `Pool`, so that this package's
   *  published declarations do not force consumers to install `@types/pg`.
   *  A real `pg.Pool` satisfies it.
   * @param opts.schemaName - The name of the schema to use
   * @param opts.tableName - The name of the table to use
   * @param opts.logger - Optional custom logger to use. Defaults to using
   *  the debug module with the @zingage/cache:postgres-store namespace
   */
  constructor(
    pool: PostgresPool,
    opts: {
      schemaName: string;
      tableName: string;
      logger?: Logger;
      assumeIsInitialized?: boolean;
    },
  ) {
    const unboundLogger =
      opts.logger ?? defaultLoggersByComponent["postgres-store"];

    this.logInfo = unboundLogger.bind(null, "postgres-store", "info");
    this.logTrace = unboundLogger.bind(null, "postgres-store", "trace");
    this.logError = unboundLogger.bind(null, "postgres-store", "error");
    this.logWarn = unboundLogger.bind(null, "postgres-store", "warn");

    this.db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    this.tableNameData = this.getTableNameData(opts.schemaName, opts.tableName);
    this.ensureInitializedPromise = opts.assumeIsInitialized
      ? Promise.resolve()
      : this.ensureInitialized();
  }

  /**
   * Joins indexed requests against stored rows and filters variants in SQL
   * with the shared variant predicate. Only matching payloads reach Node.
   * Chunks run sequentially, at most 1,000 requests / 3,000 parameters each;
   * they do not share a transaction or snapshot. Duplicates retain separate
   * result slots and may transfer the same matching payload more than once.
   * Encoding and decoding failures affect their request slots. Failed SQL
   * chunks affect their own slots; subsequent chunks still run without retries.
   */
  async getMany<
    const Reqs extends readonly StoreGetManyRequest<Spec, Params>[],
  >(
    requests: Reqs,
    options?: { signal?: AbortSignal },
  ): Promise<StoreGetManyResult<Spec, Reqs, Validators, Params>> {
    const signal = options?.signal;
    signal?.throwIfAborted();

    this.logTrace("querying for multiple entries", {
      requestCount: requests.length,
    });

    if (requests.length === 0) {
      return [] as StoreGetManyResult<Spec, Reqs, Validators, Params>;
    }

    await this.ensureInitializedPromise;

    signal?.throwIfAborted();

    type RequestRow = {
      request_index: number;
      resource_id: string;
      entry: TableEntry<Spec, Validators, Params>;
    };
    type ReadResult = Entry<Spec, Validators, Params>[] | Error;

    const readChunk = async (
      requestsChunk: readonly StoreGetManyRequest<Spec, Params>[],
      offset: number,
    ): Promise<ReadResult[]> => {
      signal?.throwIfAborted();

      const encoded = requestsChunk.map(({ id, params }, index) => {
        const requestIndex = offset + index;
        try {
          return {
            requestIndex,
            value: sql`(${requestIndex}::integer, ${id}::text, ${jsonStringify(params)}::jsonb)`,
          };
        } catch (error) {
          return asError(error);
        }
      });

      const [encodingFailures, queryRequests] = partition(
        encoded,
        (value): value is Error => value instanceof Error,
      );
      if (queryRequests.length === 0) return encodingFailures;

      const values = sql.join(queryRequests.map(({ value }) => value));
      const rows = await (async () => {
        try {
          const batch =
            await sql<RequestRow>`select r.request_index, t.resource_id, t.entry
            from ${sql.id(this.tableNameData.schemaName, this.tableNameData.tableName)} as t
            inner join (values ${values}) as r(request_index, resource_id, params)
              on t.resource_id = r.resource_id
            where ${varyMatchesParamsSql(sql.ref("t.vary"), sql.ref("r.params"))}
          `.execute(this.db);
          return batch.rows;
        } catch (failure) {
          signal?.throwIfAborted();
          return asError(failure);
        }
      })();
      if (rows instanceof Error) {
        return encoded.map((value) => (value instanceof Error ? value : rows));
      }

      signal?.throwIfAborted();

      // Every returned row must belong to a slot included in this query.
      const expectedIndices = new Set(
        queryRequests.map(({ requestIndex }) => requestIndex),
      );
      if (rows.some((row) => !expectedIndices.has(row.request_index))) {
        throw new CacheContractError(
          "Postgres returned an unexpected request index",
        );
      }

      const rowsByRequest = groupBy(rows, (row) => row.request_index);

      return encoded.map((value, index): ReadResult => {
        if (value instanceof Error) return value;

        const request = requestsChunk[index]!;
        try {
          // SQL bindings can replace lone surrogates. A different SQL key or
          // persisted ID is a miss, even if Postgres considered it a match.
          return (rowsByRequest[value.requestIndex] ?? []).flatMap((row) => {
            if (row.resource_id !== request.id) return [];

            const entry = this.deserializeEntry(row.entry);
            return entry.id === request.id ? [entry] : [];
          });
        } catch (failure) {
          // One invalid variant invalidates the complete request result.
          return asError(failure);
        }
      });
    };

    // Keep SQL chunks sequential; ordinary failures become slots, allowing
    // later chunks to run without retries or increased concurrency.
    const results: ReadResult[][] = [];
    for (const [batchIndex, requestsChunk] of chunk(
      requests,
      MAX_REQUESTS_PER_GET_MANY_QUERY,
    ).entries()) {
      results.push(
        await readChunk(
          requestsChunk,
          batchIndex * MAX_REQUESTS_PER_GET_MANY_QUERY,
        ),
      );
    }

    // Preserve duplicate slots and misses in the original request order.
    return results.flat() as StoreGetManyResult<Spec, Reqs, Validators, Params>;
  }

  async store(
    entries: readonly StoreEntryInput<Spec, Validators, Params>[],
  ): Promise<readonly StoreEntryResult[]> {
    this.logTrace("storing entries", entries);
    await this.ensureInitializedPromise;

    // Early return if there are no entries to store
    if (entries.length === 0) {
      this.logTrace("no entries to store, returning early");
      return [];
    }

    // Postgres only allows an ON CONFLICT to affect the same key once per
    // query, so collapse entries that share a slot (id + vary), keeping the
    // newest by birth date. Dropped duplicates report `{}` (they weren't the
    // value compared/stored).
    const deduped = await keepMaxPerGroupCooperatively({
      items: await timeSlicedMap(entries, (it, originalIndex) => ({
        it,
        originalIndex,
      })),
      groupBy: ({ it }) => this.slotKey(it.entry),
      maxBy: ({ it }) => entryUtils.birthDate(it.entry).getTime(),
    });

    // Sort the rows by a deterministic key so that every store() call acquires
    // its row locks in the same global order. Postgres processes a multi-row
    // INSERT's rows in order, locking each conflicting row as it goes, so two
    // concurrent calls whose batches share >= 2 slots in DIFFERENT orders
    // could otherwise deadlock (each holding a row the other is waiting on).
    // With a consistent order, the later call just waits for the earlier one.
    const rows = await timeSlicedSort(
      await timeSlicedMap(deduped, ({ it }) => {
        return {
          resource_id: it.entry.id,
          vary: this.serializeVary(it.entry.vary),
          entry: this.serializeEntry(it.entry),
        };
      }),
      (a, b) =>
        a.resource_id < b.resource_id
          ? -1
          : a.resource_id > b.resource_id
            ? 1
            : a.vary < b.vary
              ? -1
              : a.vary > b.vary
                ? 1
                : 0,
    );
    type OldRow = {
      resource_id: string;
      vary: Readonly<NormalizedVary<Params>>;
      validators: Partial<Validators>;
    };
    const readOldAndUpsert = (batch: typeof rows) =>
      this.db
        .with("old", (db) =>
          db.selectFrom(this.tableName)
            .where((eb) => eb.or(batch.map((row) => eb.and([
              eb("resource_id", "=", row.resource_id),
              eb("vary", "=", sql<Readonly<NormalizedVary<Params>>>`${row.vary}::jsonb`),
            ]))))
            .select((eb) => [
              "resource_id",
              "vary",
              sql<Partial<Validators>>`${eb.ref("entry")} -> 'validators'`.as("validators"),
            ]),
        )
        .with("upsert", (db) =>
          db.insertInto(this.tableName).values(batch)
            .onConflict((oc) => oc.columns(["resource_id", "vary"])
              .doUpdateSet((eb) => ({ entry: eb.ref("excluded.entry") }))),
        )
        .selectFrom("old").selectAll("old");
    const batchSize = 1_000;
    // Keep the one-statement fast path for ordinary small cache writes.
    const oldRows = (await (
      rows.length <= batchSize
        ? readOldAndUpsert(rows).execute()
        : this.db.transaction().execute(async (trx) => {
            const previous: OldRow[] = [];
            // Sort the whole call before batching to preserve global lock order.
            // Each batch reads only its own slots before replacing them.
            for (let start = 0; start < rows.length; start += batchSize) {
              const result = await trx.executeQuery<OldRow>(
                readOldAndUpsert(rows.slice(start, start + batchSize)).compile(),
              );
              previous.push(...result.rows);
            }
            return previous;
          })
    ).catch((error: unknown) => {
      this.logError("failed to store entries", error);
      throw error;
    })) as unknown as readonly OldRow[];
    this.logTrace("stored entries successfully");

    // Comparisons use each batch statement's pre-write snapshot.
    // A concurrent writer may still commit between that snapshot
    // and an upsert, so this metadata remains approximate under same-slot races.
    // Build comparison metadata after the transaction releases its connection.
    const oldValidatorsBySlot = new Map<string, Partial<Validators>>();
    await timeSlicedForEach(oldRows, (row) => {
      oldValidatorsBySlot.set(
        this.slotKey({ id: row.resource_id, vary: row.vary }),
        row.validators,
      );
    });

    // Map back onto the full input order; every input that isn't a winner (a
    // dropped within-call duplicate) is omitted.
    const results = await timeSlicedMap(entries, (): StoreEntryResult => ({}));
    // Each deduped ("winner") entry reports its relationship, keyed back to its
    // original input index.
    await timeSlicedForEach(deduped, ({ it, originalIndex }) => {
      results[originalIndex] = this.#relationshipToExisting(
        it.entry,
        oldValidatorsBySlot,
      );
    });
    return results;
  }

  /**
   * A canonical key for an entry's slot (resource id + vary). `jsonStringify` is
   * a stable stringify, so the same logical slot always yields the same key
   * regardless of key order or how Postgres returns the `vary` jsonb -- which is
   * what lets us match the read-back `old` rows to inputs in JS.
   */
  private slotKey(entry: {
    id: string;
    vary: Readonly<NormalizedVary<Params>>;
  }): string {
    return jsonStringify([entry.id, entry.vary]);
  }

  /**
   * How an incoming entry's validators relate to the slot's pre-call validators.
   * Empty incoming validators are omitted; a slot absent from the map is is-new.
   */
  #relationshipToExisting(
    entry: Entry<Spec, Validators, Params>,
    oldValidatorsBySlot: ReadonlyMap<string, Partial<AnyValidators>>,
  ): StoreEntryResult {
    // The old side comes back from jsonb and so is already in JSON-serialized
    // form; normalize the raw in-memory incoming side to match, so both the
    // emptiness check and the comparison agree with the other stores on
    // type-violating values (e.g. `undefined`).
    const newValidators = validatorsAsStored(entry.validators);
    if (Object.keys(newValidators).length === 0) {
      return {};
    }
    const old = oldValidatorsBySlot.get(this.slotKey(entry));
    if (old === undefined) {
      return { relationshipToExistingStoredData: "is-new" };
    }
    return {
      relationshipToExistingStoredData: validatorsEqual(old, newValidators)
        ? "unchanged"
        : "changed",
    };
  }

  async delete(id: Spec["id"]): Promise<void> {
    this.logTrace("deleting entries for id", id);
    await this.ensureInitializedPromise;

    try {
      await this.db
        .deleteFrom(this.tableName)
        .where("resource_id", "=", id)
        .execute();
      this.logTrace("deleted entries for id successfully", id);
    } catch (error) {
      this.logError("failed to delete entries for id", {
        id,
        error,
      });
      throw error;
    }
  }

  async close(): Promise<void> {
    // we don't need to do anything here, the caller should handle closing db connection
    this.logInfo("close called, but no action needed for postgres store");
  }

  async [Symbol.asyncDispose]() {
    await this.close();
  }

  private getTableNameData(schemaName: string, tableName: string) {
    if (schemaName.includes(".") || tableName.includes(".")) {
      // kysely gets really confused if we allow dots to be there, it doesn't know how to properly escape them
      // we can use sql.id to bypass that, but it's not accepted by insertInto and createTable,
      // so it forces us to use raw queries for these operations
      // I decided to stick to a simpler solution, since dots in schema/table names are very rare
      throw new Error("schema name and table name cannot include dots");
    }
    return {
      schemaName,
      tableName,
      qualifiedName: `${schemaName}.${tableName}` as CacheTableName,
    };
  }

  // just a convenience getter for qualified cache table name
  private get tableName() {
    return this.tableNameData.qualifiedName;
  }

  /**
   * Initialize the database schema and table if they don't exist.
   * This is called automatically in the constructor.
   */
  private async ensureInitialized() {
    this.logTrace("initializing database schema and table");
    try {
      await this.db.transaction().execute(async (tx) => {
        await tx.schema
          .createSchema(this.tableNameData.schemaName)
          .ifNotExists()
          .execute();

        await tx.schema
          .createTable(this.tableName)
          .ifNotExists()
          .addColumn("resource_id", "text", (col) => col.notNull())
          .addColumn("vary", "jsonb", (col) => col.notNull())
          .addColumn("entry", "jsonb", (col) => col.notNull())
          .addPrimaryKeyConstraint(`${this.tableNameData.tableName}_pkey`, [
            "resource_id",
            "vary",
          ])
          .execute();

        // I was wondering whether to use the default jsonb_ops index or jsonb_path_ops index.
        // The second one should be faster for containment queries, but the documentation says:
        //    "A disadvantage of the jsonb_path_ops approach is that it produces no index entries
        //    for JSON structures not containing any values, such as {"a": {}}.
        //    If a search for documents containing such a structure is requested, it will require a full-index scan,
        //    which is quite slow. jsonb_path_ops is therefore ill-suited for applications that often perform such searches."
        // Seeing as we'll have empty vary values very often, I decided to use the default jsonb_ops index.
        // We can come back to this and add a special handling for empty vary values if we need the performance boost.
        await tx.schema
          .createIndex(`${this.tableName}_vary_idx`)
          .ifNotExists()
          .on(this.tableName)
          .using("gin")
          .column("vary")
          .execute();
      });
      this.logInfo("database schema and table initialized successfully");
    } catch (error) {
      this.logError("failed to initialize database schema and table", error);
      throw error;
    }
  }

  private serializeEntry(entry: Entry<Spec, Validators, Params>) {
    return jsonStringify(entry) satisfies
      | JsonOf<Jsonify<Entry<Spec, Validators, Params>>>
      | undefined as JsonOf<
      JsonifiedEntry<SpecForId<Spec, Spec["id"]>, Validators, Params>
    >;
  }

  private serializeVary(
    vary: NormalizedVary<Params>,
  ): JsonOf<NormalizedVary<Params>> {
    // NormalizedVary is a legal Json
    return jsonStringify(vary) satisfies
      | JsonOf<Jsonify<NormalizedVary<Params>>>
      | undefined as JsonOf<NormalizedVary<Params>>;
  }

  private deserializeEntry<Id extends Spec["id"]>(
    entry: TableEntry<Spec, Validators, Params, Id>,
  ): EntryForId<Spec, Validators, Params, Id> {
    const _ = entry satisfies JsonifiedEntry<
      SpecForId<Spec, Id>,
      Validators,
      Params
    > as unknown as JsonifiedEntry<
      PostgresStoreCompatibleSpec,
      AnyValidators,
      AnyParams
    >;

    const date = parseDateString(
      _.date satisfies string as unknown as DateString,
    );
    if (!Number.isFinite(date.getTime())) {
      throw new Error("Invalid cached entry date");
    }
    return {
      id: _.id,
      content: _.content,
      vary: _.vary satisfies Vary<AnyParams> as NormalizedVary<Params>,
      validators: _.validators satisfies AnyValidators as Partial<Validators>,
      directives: restoreInfinityInDirectives(_.directives),
      initialAge: _.initialAge,
      date,
    } satisfies Entry<
      PostgresStoreCompatibleSpec,
      Validators,
      Params
    > as EntryForId<Spec, Validators, Params, Id>;
  }
}
