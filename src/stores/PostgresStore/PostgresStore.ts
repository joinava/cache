import { maxBy } from "es-toolkit";
import type { ColumnType } from "kysely";
import { Kysely, PostgresDialect } from "kysely";
import type { Pool } from "pg";
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
import type { Bind2 } from "../../types/utils.js";
import { restoreInfinityInDirectives } from "../../utils/normalization.js";
import { defaultLoggersByComponent, jsonStringify } from "../../utils/utils.js";

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
    vary: ColumnType<
      Readonly<NormalizedParams<Params>>,
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
 * When we match `vary` values when retrieving entries, we currently query:
 * `vary <@ $params`, which means: "is the `vary` JSON value fully contained in
 * the params". This gives the correct result when the param and vary values are
 * _primitives_ (i.e., it asks: "does the request contain a superset of the
 * params, with matching values, that the response varied on"). But, it would
 * not work if the param or vary values are objects/arrays. For example:
 *
 * {"a": {"b": {"c": "c"}}} is contained in {"a": {"b": {"c": "c", "d": "d"}}}
 * according to this operator.
 *
 * But, the rules of `vary` say that the value of param `b` has to match exactly
 * the value of `vary.b`. I.e., we want containment only at the top level and
 * then check for equality at deeper levels. To do that, we could use ? and =
 * operators while iterating over the vary keys, but, since we're not
 * implementing that for now, we restrict this store to a set of param values
 * that are safe.
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
 * This class implements a store for cache entries, backed by Postgres. For
 * details on each method, see the Store interface.
 *
 * Each row in the table is a separate cache entry, uniquely identified by
 * (resourceId, vary) pair. Each of these rows stores the id (string), vary
 * (jsonb), and a full entry (jsonb).
 *
 * We do not use any mechanisms to speed up the entry lookup aside from an index
 * on the vary column. We rely on Postgres to be fast enough for our needs.
 */
export default class PostgresStore<
  Spec extends PostgresStoreCompatibleSpec = PostgresStoreCompatibleSpec,
  Validators extends AnyValidators = AnyValidators,
  Params extends PostgresStoreSupportedParams = PostgresStoreSupportedParams,
> implements Store<Spec, Validators, Params> {
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
   * @param pool - The postgres pool to use
   * @param opts.schemaName - The name of the schema to use
   * @param opts.tableName - The name of the table to use
   * @param opts.logger - Optional custom logger to use. Defaults to using
   *  the debug module with the @zingage/cache:postgres-store namespace
   */
  constructor(
    pool: Pool,
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

  async get<Id extends Spec["id"]>(
    id: Id,
    params: Readonly<NormalizedParams<Params>>,
    options?: { signal?: AbortSignal },
  ): Promise<EntryForId<Spec, Validators, Params, Id>[]> {
    const signal = options?.signal;
    signal?.throwIfAborted();

    this.logTrace("querying for entries with id and params", {
      id,
      params,
    });
    await this.ensureInitializedPromise;

    signal?.throwIfAborted();

    const result = await this.db
      .selectFrom(this.tableName)
      .where("resource_id", "=", id)
      // operator means: "Are the left JSON path/value entries contained at the
      // top level within the right JSON value?" This is only right in the
      // limited cases we support; see comment on PostgresRestrictedParams.
      .where("vary", "<@", params)
      .selectAll()
      .execute();

    signal?.throwIfAborted();

    const entries = result.map((it) =>
      this.deserializeEntry(
        it.entry satisfies TableEntry<
          Spec,
          Validators,
          Params,
          Spec["id"]
        > as unknown as TableEntry<Spec, Validators, Params, Id>,
      ),
    );

    this.logTrace("returning entries from postgres query", entries);
    return entries;
  }

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

    const ids = [...new Set(requests.map(({ id }) => id))];
    const result = await this.db
      .selectFrom(this.tableName)
      .select(["resource_id", "vary", "entry"])
      .where("resource_id", "in", ids)
      .execute();

    signal?.throwIfAborted();

    const rowsById = Map.groupBy(result, ({ resource_id }) => resource_id);
    const entriesForRequests = requests.map(({ id, params }) =>
      (rowsById.get(id) ?? [])
        .filter(({ vary }) =>
          postgresVaryMatchesRequest(
            vary as unknown as NormalizedVary<Params>,
            params,
          ),
        )
        .map(({ entry }) =>
          this.deserializeEntry(
            entry satisfies TableEntry<
              Spec,
              Validators,
              Params,
              Spec["id"]
            > as TableEntry<Spec, Validators, Params, Spec["id"]>,
          ),
        ),
    );

    return entriesForRequests as StoreGetManyResult<
      Spec,
      Reqs,
      Validators,
      Params
    >;
  }

  async store(
    entries: readonly StoreEntryInput<Spec, Validators, Params>[],
  ): Promise<void> {
    this.logTrace("storing entries", entries);
    await this.ensureInitializedPromise;

    // Early return if there are no entries to store
    if (entries.length === 0) {
      this.logTrace("no entries to store, returning early");
      return;
    }

    try {
      await this.db
        .insertInto(this.tableName)
        .values(
          // Postgres only allows an ON CONFLICT to affect the same key once per
          // query, so we need to make sure that the entries are unique by id and
          // vary; if not, we need to choose the one with the newest birth date.
          keepMaxPerGroup({
            items: entries,
            groupBy: (it) => {
              const { id, vary } = it.entry;
              const key = [id, this.serializeVary(vary)] as const;
              return jsonStringify(key) satisfies JsonOf<
                Jsonify<[unknown, JsonOf<NormalizedVary<Params>>]>
              > as unknown as JsonOf<[string, JsonOf<NormalizedVary<Params>>]>;
            },
            maxBy: (it) => entryUtils.birthDate(it.entry).getTime(),
          }).map((it) => {
            const { id, vary } = it.entry;
            return {
              resource_id: id,
              vary: this.serializeVary(vary),
              entry: this.serializeEntry(it.entry),
            };
          }),
        )
        .onConflict((oc) =>
          // should this use a conflict on primary key instead? not sure what's the performance difference
          oc.columns(["resource_id", "vary"]).doUpdateSet((eb) => ({
            entry: eb.ref("excluded.entry"),
          })),
        )
        .execute();
      this.logTrace("stored entries successfully");
    } catch (error) {
      this.logError("failed to store entries", error);
      throw error;
    }
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

  async [Symbol.asyncDispose]() {
    // we don't need to do anything here, the caller should handle closing db connection
    this.logInfo(
      "[Symbol.asyncDispose] called, but no action needed for postgres store",
    );
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

    return {
      id: _.id,
      content: _.content,
      vary: _.vary satisfies Vary<AnyParams> as NormalizedVary<Params>,
      validators: _.validators satisfies AnyValidators as Partial<Validators>,
      directives: restoreInfinityInDirectives(_.directives),
      initialAge: _.initialAge,
      date: parseDateString(_.date satisfies string as unknown as DateString),
    } satisfies Entry<
      PostgresStoreCompatibleSpec,
      Validators,
      Params
    > as EntryForId<Spec, Validators, Params, Id>;
  }
}

function postgresVaryMatchesRequest<Params extends AnyParams>(
  vary: NormalizedVary<Params>,
  params: Readonly<NormalizedParams<Params>>,
) {
  // Match PostgreSQL's JSONB containment semantics for the primitive params
  // supported by this store. In particular, JSON null is not the same as an
  // absent property.
  return Object.entries(vary).every(
    ([key, value]) =>
      Object.prototype.hasOwnProperty.call(params, key) &&
      params[key] === value,
  );
}

function keepMaxPerGroup<T>(opts: {
  items: readonly T[];
  groupBy: (item: T) => string;
  maxBy: (item: T) => number;
}): T[] {
  return Map.groupBy(opts.items, opts.groupBy)
    .values()
    .map((group) =>
      // Non-null assertions are safe because the group cannot be empty,
      // or it wouldn't have an entry in the Map.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      group.length > 1 ? maxBy(group, opts.maxBy)! : group[0]!,
    )
    .toArray();
}
