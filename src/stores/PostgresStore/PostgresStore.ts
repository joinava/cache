import { maxBy } from "es-toolkit";
import type { ColumnType } from "kysely";
import { Kysely, PostgresDialect } from "kysely";
import type { Pool } from "pg";
import type { Jsonify, Tagged } from "type-fest";
import type { DateString, JsonOf, JSONWithUndefined } from "type-party";
import { parseDateString } from "type-party/runtime/dates.js";
import { entryUtils } from "../../index.js";
import type { AnyParams } from "../../types/01_Params.js";
import type { AnyValidators } from "../../types/02_Validators.js";
import type {
  Entry,
  NormalizedParams,
  NormalizedVary,
} from "../../types/06_Normalization.js";
import type { Logger, Store, StoreEntryInput } from "../../types/index.js";
import type { Bind2 } from "../../types/utils.js";
import {
  defaultLoggersByComponent,
  jsonStringify,
  naiveGetMany,
} from "../../utils/utils.js";

/**
 * Type representing the qualified name of the cache table.
 */
type CacheTableName = Tagged<string, "CacheTableName">;

/**
 * Type representing the entry in the cache table. It's basically the same as
 * the Entry type, but the date is a string since that's what it ends up as
 * after roundtripping through JSON. I tried using Jsonify from type-fest, but
 * it didn't seem to work - deserialize function thought there was no date key.
 */
type TableEntry<
  Content extends JSONWithUndefined,
  Validators extends AnyValidators,
  Params extends AnyParams,
  Id extends string,
> = Omit<Entry<Content, Validators, Params, Id>, "date"> & {
  date: DateString;
};

type CacheTables<
  Content extends JSONWithUndefined,
  Validators extends AnyValidators,
  Params extends AnyParams,
  Id extends string,
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
      TableEntry<Content, Validators, Params, Id>,
      JsonOf<Entry<Content, Validators, Params, Id>>,
      JsonOf<Entry<Content, Validators, Params, Id>>
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
  Content extends JSONWithUndefined,
  Validators extends AnyValidators = AnyValidators,
  Params extends PostgresStoreSupportedParams = PostgresStoreSupportedParams,
  Id extends string = string,
> implements Store<Content, Validators, Params, Id> {
  /** Object containing info about the schema and table name */
  private readonly tableNameData: {
    schemaName: string;
    tableName: string;
    qualifiedName: CacheTableName;
  };
  private readonly db: Kysely<CacheTables<Content, Validators, Params, Id>>;
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

  async get(
    id: Id,
    params: Readonly<NormalizedParams<Params>>,
  ): Promise<Entry<Content, Validators, Params, Id>[]> {
    this.logTrace("querying for entries with id and params", {
      id,
      params,
    });
    await this.ensureInitializedPromise;

    const result = await this.db
      .selectFrom(this.tableName)
      .where("resource_id", "=", id)
      // operator means: "Are the left JSON path/value entries contained at the
      // top level within the right JSON value?" This is only right in the
      // limited cases we support; see comment on PostgresRestrictedParams.
      .where("vary", "<@", params)
      .selectAll()
      .execute();

    const entries = result.map((it) => this.deserializeEntry(it.entry));
    this.logTrace("returning entries from postgres query", entries);
    return entries;
  }

  async getMany(
    requests: readonly {
      readonly id: Id;
      readonly params: Readonly<NormalizedParams<Params>>;
    }[],
  ): Promise<Array<Entry<Content, Validators, Params, Id>[]>> {
    this.logTrace("querying for multiple entries", {
      requestCount: requests.length,
    });

    // For PostgresStore, we'll use the naive implementation until we have time to optimize it
    return naiveGetMany(this, requests);
  }

  async store(
    entries: readonly StoreEntryInput<Content, Validators, Params, Id>[],
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
            groupBy: (it) =>
              jsonStringify([it.entry.id, this.serializeVary(it.entry.vary)]),
            maxBy: (it) => entryUtils.birthDate(it.entry).getTime(),
          }).map((it) => ({
            resource_id: it.entry.id,
            vary: this.serializeVary(it.entry.vary),
            entry: this.serializeEntry(it.entry),
          })),
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

  async delete(id: Id): Promise<void> {
    this.logTrace("deleting entries for id", id);
    await this.ensureInitialized();

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

  async close() {
    // we don't need to do anything here, the caller should handle closing db connection
    this.logInfo("close called, but no action needed for postgres store");
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

  private serializeEntry(entry: Entry<Content, Validators, Params, Id>) {
    return jsonStringify(entry);
  }

  private serializeVary(vary: NormalizedVary<Params>) {
    return jsonStringify(vary);
  }

  private deserializeEntry(
    entry: TableEntry<Content, Validators, Params, Id>,
  ): Entry<Content, Validators, Params, Id> {
    return {
      ...entry,
      date: parseDateString(entry.date),
    };
  }
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
