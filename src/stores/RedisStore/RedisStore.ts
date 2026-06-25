import { maxBy } from "es-toolkit";
import type { Cluster, Redis } from "ioredis";
import type {
  DateString,
  Jsonify,
  JsonOf,
  JSONWithUndefined,
} from "type-party";
import { parseDateString } from "type-party/runtime/dates.js";
import { jsonParse, jsonStringify } from "type-party/runtime/json.js";

import type { CacheSpec } from "../../types/00_CacheSpec.js";
import type { AnyParams } from "../../types/01_Params.js";
import type { AnyValidators } from "../../types/02_Validators.js";
import type {
  Entry,
  JsonifiedEntry,
  NormalizedParams,
  NormalizedProducerDirectives,
  NormalizedVary,
} from "../../types/06_Normalization.js";
import type { StoreGetManyResult } from "../../types/06_Store.js";
import type {
  EntryForId,
  Logger,
  ProducerDirectives,
  Store,
  StoreEntryInput,
  StoreGetManyRequest,
  Vary,
} from "../../types/index.js";
import { birthDate } from "../../utils/normalizedProducerResultResourceHelpers.js";
import {
  requestVariantKeyForVaryKeys,
  resultVariantKey,
  type VariantKey,
  type VaryKeys,
} from "../../utils/varyHelpers.js";

export type RedisStoreCompatibleSpec = CacheSpec<string, JSONWithUndefined>;
export type RedisStoreSupportedParams = {
  [paramName: string]: string | number | boolean | undefined;
};

/**
 * The Redis client type accepted by RedisStore. In ioredis terms this is
 * `Redis | Cluster` — pass an instance of either. Mocks satisfying the same
 * surface (e.g., `ioredis-mock`) also work.
 */
export type RedisStoreClient = Redis | Cluster;

type StoredVariantBlob = JsonOf<JsonifiedEntry<CacheSpec, AnyValidators, AnyParams>>;
type VaryKeysJson = JsonOf<readonly string[]>;

const DEFAULT_KEY_PREFIX = "cache";
const DEFAULT_ID_MAX_LENGTH = 512;
const DEFAULT_FALLBACK_DELETE_AFTER_SECONDS = 30 * 24 * 60 * 60;

/**
 * Atomic check-and-remove for a dangling variant in the index. If the variant
 * blob no longer exists, prune the index entry; otherwise leave it alone.
 * Runs in a single Lua invocation so the EXISTS observation cannot be
 * invalidated by a concurrent `store()` before the ZREM.
 *
 * Correctness invariant: `store()`'s pipeline writes the variant blob (SET)
 * BEFORE adding to `variantKeys` (ZADD). So if `get()` sees a variantKey in
 * the index but `MGET` returns null, the blob has either been TTL'd or
 * `delete()`d — never "is about to land". If you reorder the pipeline so
 * ZADD precedes SET, this script is no longer safe.
 *
 *   KEYS[1] = cache:{id}:v:<variantKey>
 *   KEYS[2] = cache:{id}:variantKeys
 *   ARGV[1] = <variantKey>
 */
const SELF_HEAL_LUA = `
if redis.call("EXISTS", KEYS[1]) == 0 then
  redis.call("ZREM", KEYS[2], ARGV[1])
  return 1
end
return 0
`;

/**
 * Atomic invalidation of all keys for an id.
 *
 * Enumerates `variantKeys` (a sorted set), then deletes every variant blob
 * plus the two index keys, all in one Redis-server tick. This prevents the
 * race where a concurrent `store()` lands a SET + ZADD between `delete()`'s
 * read of the variant list and its DEL — without the script, that race
 * orphans the just-written variant blob (it has no index entry pointing at
 * it, so subsequent `get()` won't find it, but the blob persists until TTL
 * fires).
 *
 * KEYS[1] = cache:{id}:varyKeySets
 * KEYS[2] = cache:{id}:variantKeys
 * ARGV[1] = key prefix for variant keys, formatted as `cache:{id}:v:`
 *           (without the trailing variantKey)
 */
const DELETE_ID_LUA = `
local variantKeys = redis.call("ZRANGE", KEYS[2], 0, -1)
local toDelete = { KEYS[1], KEYS[2] }
for i, vk in ipairs(variantKeys) do
  toDelete[#toDelete + 1] = ARGV[1] .. vk
end
return redis.call("DEL", unpack(toDelete))
`;

/**
 * A {@link Store} backed by Redis.
 *
 * For each resource `id`, the store keeps three key shapes — all sharing the
 * `{<encodedId>}` Cluster hashtag so variants and indexes co-locate on one
 * shard:
 *
 *   cache:{<id>}:v:<variantKey>   STRING  the JSON-serialized entry blob;
 *                                         per-key TTL via SET PX.
 *   cache:{<id>}:varyKeySets      SET     canonical-JSON of the vary key-name
 *                                         arrays seen for this id (usually 1
 *                                         element). Drives the get() lookup.
 *   cache:{<id>}:variantKeys      ZSET    all live variant keys for this id,
 *                                         scored by the entry's epoch-ms
 *                                         expiry. Drives delete() and index
 *                                         hygiene; auto-pruned on each write
 *                                         via ZREMRANGEBYSCORE so unbounded
 *                                         vary cardinality can't compound.
 *
 * Mirrors the MemoryStore design (varyKeysSets + entryVariantKeys), translated
 * to Redis primitives. Reads = one `SMEMBERS varyKeySets` plus one `MGET` of
 * the matching variants — the ZSET is never consulted on the read path. Writes
 * = a pipelined `SET` + `SADD` + `ZADD` + `PEXPIRE`s + `ZREMRANGEBYSCORE`.
 *
 * The Redis client is provided by the caller (an `ioredis.Redis` or
 * `ioredis.Cluster` instance, or anything satisfying {@link RedisStoreClient}).
 * The store does not own or close the client — that's the caller's
 * responsibility, matching {@link PostgresStore}'s `pool` injection pattern.
 */
export default class RedisStore<
  Spec extends RedisStoreCompatibleSpec = RedisStoreCompatibleSpec,
  Validators extends AnyValidators = AnyValidators,
  Params extends RedisStoreSupportedParams = RedisStoreSupportedParams,
> implements Store<Spec, Validators, Params> {
  readonly #redis: RedisStoreClient;
  readonly #keyPrefix: string;
  readonly #idMaxLength: number;
  readonly #fallbackDeleteAfterMs: number;
  readonly #log: Logger;

  // Resolves once Redis has the Lua scripts loaded. We load lazily and cache
  // the SHAs so the constructor stays synchronous.
  #selfHealSha: Promise<string> | undefined;
  #deleteIdSha: Promise<string> | undefined;

  // Pending Self-heals fired without await; we observe rejection so they don't
  // crash the process and we keep a reference so close() can wait for in-flight
  // self-heals to settle. Soft-capped to bound memory if Redis is slow.
  readonly #pendingSelfHeals = new Set<Promise<void>>();
  static readonly #PENDING_SELF_HEAL_CAP = 256;

  /**
   * @param redis An ioredis-compatible client (`Redis` or `Cluster`). Caller
   *   owns the lifecycle; the store does not close it.
   * @param opts.keyPrefix Default `"cache"`. Prepended to every key as
   *   `<keyPrefix>:{<encodedId>}:…`.
   * @param opts.idMaxLength Maximum allowed length of an `id` (in characters)
   *   the store will accept. Default 512. Exists to surface producer bugs that
   *   generate enormous keys; the cap can be raised but Redis performance
   *   degrades with very long key names.
   * @param opts.fallbackDeleteAfter Seconds. When the Cache asks the store to
   *   keep an entry "forever" (`maxStoreForSeconds === Infinity`), use this as
   *   the actual TTL. Default 30 days, matching SqliteStore.
   * @param opts.logger Optional custom logger.
   */
  public constructor(
    redis: RedisStoreClient,
    opts?: {
      keyPrefix?: string;
      idMaxLength?: number;
      fallbackDeleteAfter?: number;
      logger?: Logger;
    },
  ) {
    this.#redis = redis;
    this.#keyPrefix = opts?.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.#idMaxLength = opts?.idMaxLength ?? DEFAULT_ID_MAX_LENGTH;
    this.#fallbackDeleteAfterMs =
      (opts?.fallbackDeleteAfter ?? DEFAULT_FALLBACK_DELETE_AFTER_SECONDS) *
      1000;
    this.#log = opts?.logger ?? noopLogger;
  }

  public async get<Id extends Spec["id"]>(
    id: Id,
    params: Readonly<NormalizedParams<Params>>,
    options?: { signal?: AbortSignal },
  ): Promise<EntryForId<Spec, Validators, Params, Id>[]> {
    options?.signal?.throwIfAborted();
    this.#assertValidId(id);

    const keys = this.#keysForId(id);
    const varyKeySetsJson = (await this.#redis.smembers(
      keys.varyKeySets,
    )) as VaryKeysJson[];

    options?.signal?.throwIfAborted();

    if (varyKeySetsJson.length === 0) {
      return [];
    }

    // Each member of varyKeySets is the canonical JSON of a vary-key-name
    // array. Two different members can yield the same variantKey for a given
    // request only by coincidence; dedupe to avoid redundant MGET slots.
    const variantKeyToFingerprint = new Map<VariantKey, VaryKeysJson>();
    for (const varyKeysJson of varyKeySetsJson) {
      const varyKeys = jsonParse(varyKeysJson) as VaryKeys;
      const variantKey = requestVariantKeyForVaryKeys(params, varyKeys);
      if (!variantKeyToFingerprint.has(variantKey)) {
        variantKeyToFingerprint.set(variantKey, varyKeysJson);
      }
    }

    const orderedVariantKeys = [...variantKeyToFingerprint.keys()];
    const variantRedisKeys = orderedVariantKeys.map((vk) =>
      this.#variantKey(id, vk),
    );

    const blobs = (await this.#redis.mget(variantRedisKeys)) as (
      | StoredVariantBlob
      | null
    )[];

    options?.signal?.throwIfAborted();

    const entries: EntryForId<Spec, Validators, Params, Id>[] = [];
    const danglingVariantKeys: VariantKey[] = [];
    for (let i = 0; i < orderedVariantKeys.length; i += 1) {
      const blob = blobs[i];
      const variantKey = orderedVariantKeys[i];
      if (variantKey === undefined) continue;
      if (blob == null) {
        danglingVariantKeys.push(variantKey);
        continue;
      }
      entries.push(this.#deserializeEntry<Id>(blob));
    }

    if (danglingVariantKeys.length > 0) {
      this.#scheduleSelfHeal(id, danglingVariantKeys);
    }

    return entries;
  }

  public async getMany<
    const Reqs extends readonly StoreGetManyRequest<Spec, Params>[],
  >(
    requests: Reqs,
    options?: { signal?: AbortSignal },
  ): Promise<StoreGetManyResult<Spec, Reqs, Validators, Params>> {
    options?.signal?.throwIfAborted();

    if (requests.length === 0) {
      return [] as StoreGetManyResult<Spec, Reqs, Validators, Params>;
    }

    for (const { id } of requests) {
      this.#assertValidId(id);
    }

    // Pipeline the SMEMBERS calls so each request only costs ~one RTT for the
    // varyKeySets fetch. We still need a second pipelined batch for the MGETs
    // because each request's MGET key list depends on its SMEMBERS response.
    //
    // Cluster compatibility: each request's SMEMBERS+MGET share the same `{id}`
    // hashtag so they land on the same slot, but different requests in the
    // same getMany can target different slots. ioredis's pipeline handles this
    // transparently for non-Cluster clients; for Cluster, the cluster pipeline
    // dispatches per-slot under the hood.
    const varyKeySetsPipeline = this.#redis.pipeline();
    for (const { id } of requests) {
      varyKeySetsPipeline.smembers(this.#keysForId(id).varyKeySets);
    }
    const varyKeySetsResults = (await varyKeySetsPipeline.exec()) as
      | [Error | null, VaryKeysJson[]][]
      | null;

    options?.signal?.throwIfAborted();

    if (varyKeySetsResults === null) {
      throw new Error(
        "RedisStore: varyKeySets pipeline returned null (Redis client returned no replies)",
      );
    }

    // Per-request: compute the variantKeys to MGET, building one big MGET in
    // a second pipeline. We track the slice [start, end) of each request's
    // variants in the consolidated key list so we can split the results back.
    const consolidatedKeys: string[] = [];
    const perRequestPlans: {
      variantKeys: VariantKey[];
      start: number;
      end: number;
    }[] = [];

    for (let i = 0; i < requests.length; i += 1) {
      const request = requests[i];
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const slot = varyKeySetsResults[i]!;
      const error = slot[0];
      if (error) {
        throw error;
      }
      const varyKeysJsonList = slot[1];

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const { id, params } = request!;

      const variantKeyToFingerprint = new Map<VariantKey, true>();
      for (const varyKeysJson of varyKeysJsonList) {
        const varyKeys = jsonParse(varyKeysJson) as VaryKeys;
        const variantKey = requestVariantKeyForVaryKeys(params, varyKeys);
        if (!variantKeyToFingerprint.has(variantKey)) {
          variantKeyToFingerprint.set(variantKey, true);
        }
      }

      const variantKeys = [...variantKeyToFingerprint.keys()];
      const start = consolidatedKeys.length;
      for (const vk of variantKeys) {
        consolidatedKeys.push(this.#variantKey(id, vk));
      }
      perRequestPlans.push({
        variantKeys,
        start,
        end: consolidatedKeys.length,
      });
    }

    // If no request had any variantKeys to fetch, short-circuit.
    if (consolidatedKeys.length === 0) {
      return requests.map(() => []) as StoreGetManyResult<
        Spec,
        Reqs,
        Validators,
        Params
      >;
    }

    // Fetch via a pipeline of per-id MGETs rather than one giant MGET. In
    // Cluster mode, a single MGET spanning multiple slots fails with
    // CROSSSLOT — variant keys for different ids hash to different slots, so
    // the giant-MGET shape only works for standalone Redis. The per-id
    // pipeline is correct under both modes (each MGET stays within one slot
    // via the `{<id>}` hashtag), and ioredis's cluster pipeline transparently
    // dispatches per-slot.
    const blobs: (StoredVariantBlob | null)[] = Array.from({
      length: consolidatedKeys.length,
    });
    const mgetPipeline = this.#redis.pipeline();
    const mgetCallSpans: { start: number; end: number }[] = [];
    for (let i = 0; i < requests.length; i += 1) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const plan = perRequestPlans[i]!;
      if (plan.start === plan.end) {
        mgetCallSpans.push({ start: plan.start, end: plan.end });
        continue;
      }
      mgetPipeline.mget(consolidatedKeys.slice(plan.start, plan.end));
      mgetCallSpans.push({ start: plan.start, end: plan.end });
    }
    const mgetResults = (await mgetPipeline.exec()) as
      | [Error | null, (StoredVariantBlob | null)[]][]
      | null;

    if (mgetResults === null) {
      throw new Error(
        "RedisStore: getMany MGET pipeline returned null (Redis client returned no replies)",
      );
    }

    let resultIdx = 0;
    for (const span of mgetCallSpans) {
      if (span.start === span.end) continue;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const slot = mgetResults[resultIdx]!;
      resultIdx += 1;
      const error = slot[0];
      if (error) {
        throw error;
      }
      const chunkBlobs = slot[1];
      for (let j = 0; j < chunkBlobs.length; j += 1) {
        blobs[span.start + j] = chunkBlobs[j] ?? null;
      }
    }

    options?.signal?.throwIfAborted();

    // Split blobs back per-request and deserialize.
    const results = requests.map((request, i) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const plan = perRequestPlans[i]!;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const { id } = request!;
      const entries: EntryForId<Spec, Validators, Params, Spec["id"]>[] = [];
      const danglingVariantKeys: VariantKey[] = [];
      for (let j = 0; j < plan.variantKeys.length; j += 1) {
        const blob = blobs[plan.start + j];
        const variantKey = plan.variantKeys[j];
        if (variantKey === undefined) continue;
        if (blob == null) {
          danglingVariantKeys.push(variantKey);
          continue;
        }
        entries.push(
          this.#deserializeEntry<Spec["id"]>(blob) as EntryForId<
            Spec,
            Validators,
            Params,
            Spec["id"]
          >,
        );
      }
      if (danglingVariantKeys.length > 0) {
        this.#scheduleSelfHeal(id, danglingVariantKeys);
      }
      return entries;
    });

    return results satisfies EntryForId<
      Spec,
      Validators,
      Params,
      Spec["id"]
    >[][] as {
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
    if (entries.length === 0) return;

    // Within a single store() call, collapse duplicate (id, variantKey) entries
    // down to the newest by birthDate, matching PostgresStore and SqliteStore.
    const groupedByVariant = Map.groupBy(entries, ({ entry }) =>
      jsonStringify([entry.id, resultVariantKey(entry.vary)]),
    );

    type PreparedEntry = {
      readonly id: Spec["id"];
      readonly variantKey: VariantKey;
      readonly varyKeysJson: VaryKeysJson;
      readonly blob: StoredVariantBlob;
      readonly ttlMs: number;
      readonly expiryMs: number;
    };

    // Single wall-clock reading shared by every entry in this call, so all
    // expiry scores and the per-id sweep cutoff agree.
    const now = Date.now();

    const prepared: PreparedEntry[] = [];
    for (const group of groupedByVariant.values()) {
      if (group.length === 0) continue;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const newest = group.length === 1 ? group[0]! : maxBy(group, (it) =>
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        birthDate(it.entry).valueOf(),
      )!;
      const { entry, maxStoreForSeconds } = newest;
      this.#assertValidId(entry.id);
      const ttlMs =
        maxStoreForSeconds === Infinity
          ? this.#fallbackDeleteAfterMs
          : Math.max(1, Math.round(maxStoreForSeconds * 1000));
      const variantKey = resultVariantKey(entry.vary);
      const varyKeysJson = jsonStringify(
        Object.keys(entry.vary).toSorted(),
      ) as VaryKeysJson;
      prepared.push({
        id: entry.id,
        variantKey,
        varyKeysJson,
        blob: this.#serializeEntry(entry),
        ttlMs,
        expiryMs: now + ttlMs,
      });
    }

    if (prepared.length === 0) return;

    const pipeline = this.#redis.pipeline();
    // Track ids we've already issued the auto-prune sweep for, to avoid
    // emitting ZREMRANGEBYSCORE per entry when many entries target the same
    // id within one store() call.
    const sweptIds = new Set<Spec["id"]>();
    // Cluster note: each PreparedEntry's three keys share the same `{id}`
    // hashtag, so they all land on the same slot. Entries with different ids
    // may land on different slots, which ioredis's cluster pipeline handles
    // by dispatching per-slot under the hood.
    for (const p of prepared) {
      const keys = this.#keysForId(p.id);
      pipeline.set(this.#variantKey(p.id, p.variantKey), p.blob, "PX", p.ttlMs);
      pipeline.sadd(keys.varyKeySets, p.varyKeysJson);
      // Score by the entry's expiry so the ZSET self-prunes via the
      // ZREMRANGEBYSCORE below. A re-store of the same (id, vk) overwrites
      // the score, which is correct because SET PX also overwrites the
      // blob's TTL: score and blob expiry track each other.
      pipeline.zadd(keys.variantKeys, p.expiryMs, p.variantKey);
      // Keep the index keys alive at least as long as the longest variant
      // TTL. We use plain PEXPIRE rather than PEXPIRE … GT (added in Redis
      // 7.0) for broader compatibility; in the worst case an index key
      // expires slightly earlier than its variants, which yields a legal
      // (if pessimistic) empty `get()`.
      pipeline.pexpire(keys.varyKeySets, p.ttlMs);
      pipeline.pexpire(keys.variantKeys, p.ttlMs);
      // Sweep entries whose expiry has already passed from the index. This
      // is the load-bearing property of the ZSET design: even if a producer
      // varies on a high-cardinality param, the index only ever holds
      // members whose underlying variant blob is still potentially-live.
      if (!sweptIds.has(p.id)) {
        sweptIds.add(p.id);
        pipeline.zremrangebyscore(keys.variantKeys, 0, now);
      }
    }
    const results = (await pipeline.exec()) as [Error | null, unknown][] | null;
    if (results === null) {
      throw new Error("RedisStore: store pipeline returned null");
    }
    for (const [error] of results) {
      if (error) throw error;
    }
  }

  public async delete(id: Spec["id"]): Promise<void> {
    this.#assertValidId(id);
    const keys = this.#keysForId(id);
    const variantPrefix = `${this.#keyPrefix}:{${encodeId(id)}}:v:`;

    // Use Lua so the ZRANGE+DEL pair is atomic on the shard. A naive
    // ZRANGE-then-DEL loses a concurrent store(): if another client's
    // SET v:vk + ZADD variantKeys vk lands between our ZRANGE and our DEL,
    // the DEL targets only the index keys and the freshly-written variant
    // blob persists as an orphan until TTL.
    const sha = await this.#loadScript(
      "deleteId",
      DELETE_ID_LUA,
      () => this.#deleteIdSha,
      (p) => (this.#deleteIdSha = p),
    );
    try {
      await this.#redis.evalsha(
        sha,
        2,
        keys.varyKeySets,
        keys.variantKeys,
        variantPrefix,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("NOSCRIPT")) {
        this.#deleteIdSha = undefined;
        const freshSha = await this.#loadScript(
          "deleteId",
          DELETE_ID_LUA,
          () => this.#deleteIdSha,
          (p) => (this.#deleteIdSha = p),
        );
        await this.#redis.evalsha(
          freshSha,
          2,
          keys.varyKeySets,
          keys.variantKeys,
          variantPrefix,
        );
      } else {
        throw error;
      }
    }
  }

  public async close(_timeout?: number): Promise<void> {
    // Wait for in-flight self-heals so we don't leave dangling promises behind
    // when the test harness closes the Redis client out from under us.
    if (this.#pendingSelfHeals.size > 0) {
      await Promise.allSettled(this.#pendingSelfHeals);
    }
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  #keysForId(id: Spec["id"]) {
    const tag = `{${encodeId(id)}}`;
    return {
      varyKeySets: `${this.#keyPrefix}:${tag}:varyKeySets`,
      variantKeys: `${this.#keyPrefix}:${tag}:variantKeys`,
    };
  }

  #variantKey(id: Spec["id"], variantKey: VariantKey): string {
    return `${this.#keyPrefix}:{${encodeId(id)}}:v:${variantKey}`;
  }

  #assertValidId(id: string): void {
    if (id.length > this.#idMaxLength) {
      throw new Error(
        `RedisStore: id length ${id.length} exceeds idMaxLength ${this.#idMaxLength}`,
      );
    }
  }

  async #loadScript(
    _name: string,
    source: string,
    get: () => Promise<string> | undefined,
    set: (p: Promise<string>) => void,
  ): Promise<string> {
    const existing = get();
    if (existing !== undefined) return existing;
    const loading = (async () => {
      return (await this.#redis.script("LOAD", source)) as string;
    })();
    set(loading);
    try {
      return await loading;
    } catch (error) {
      // On failure, clear the cached promise so the next call retries fresh.
      set(undefined as unknown as Promise<string>);
      throw error;
    }
  }

  #scheduleSelfHeal(id: Spec["id"], danglingVariantKeys: VariantKey[]): void {
    if (danglingVariantKeys.length === 0) return;
    // Soft cap: under sustained slow-Redis pressure we'd otherwise queue
    // unbounded promises (each holding its danglingVariantKeys array). Drop
    // new self-heals beyond the cap; the next successful read will re-detect
    // and re-schedule.
    if (this.#pendingSelfHeals.size >= RedisStore.#PENDING_SELF_HEAL_CAP) {
      this.#log(
        "redis-store",
        "warn",
        "RedisStore self-heal queue is full; dropping pending self-heal",
        { id, droppedVariantCount: danglingVariantKeys.length },
      );
      return;
    }

    const keys = this.#keysForId(id);
    const promise = (async () => {
      const runOnce = async (variantKey: VariantKey, sha: string) => {
        await this.#redis.evalsha(
          sha,
          2,
          this.#variantKey(id, variantKey),
          keys.variantKeys,
          variantKey,
        );
      };

      try {
        let sha = await this.#loadScript(
          "selfHeal",
          SELF_HEAL_LUA,
          () => this.#selfHealSha,
          (p) => (this.#selfHealSha = p),
        );
        for (const variantKey of danglingVariantKeys) {
          try {
            await runOnce(variantKey, sha);
          } catch (error) {
            // NOSCRIPT: Redis dropped the script (e.g., after FLUSHSCRIPTS).
            // Reload and retry once.
            if (
              error instanceof Error &&
              error.message.includes("NOSCRIPT")
            ) {
              this.#selfHealSha = undefined;
              sha = await this.#loadScript(
                "selfHeal",
                SELF_HEAL_LUA,
                () => this.#selfHealSha,
                (p) => (this.#selfHealSha = p),
              );
              await runOnce(variantKey, sha);
            } else {
              this.#log(
                "redis-store",
                "warn",
                "RedisStore self-heal failed for variant",
                { id, variantKey, error },
              );
              return;
            }
          }
        }
      } catch (error) {
        this.#log(
          "redis-store",
          "warn",
          "RedisStore self-heal script load failed",
          { id, error },
        );
      }
    })();
    this.#pendingSelfHeals.add(promise);
    void promise.finally(() => {
      this.#pendingSelfHeals.delete(promise);
    });
  }

  #serializeEntry(entry: Entry<Spec, Validators, Params>): StoredVariantBlob {
    const serialized = jsonStringify(entry) satisfies
      | JsonOf<Jsonify<Entry<Spec, Validators, Params>>>
      | undefined as
      | JsonOf<JsonifiedEntry<Spec, Validators, Params>>
      | undefined;
    if (serialized === undefined) {
      throw new Error("RedisStore: could not serialize entry to JSON");
    }
    return serialized satisfies JsonOf<
      JsonifiedEntry<Spec, Validators, Params>
    > as unknown as StoredVariantBlob;
  }

  #deserializeEntry<Id extends Spec["id"]>(
    blob: StoredVariantBlob,
  ): EntryForId<Spec, Validators, Params, Id> {
    const parsed = jsonParse(
      blob as unknown as JsonOf<
        JsonifiedEntry<RedisStoreCompatibleSpec, AnyValidators, AnyParams>
      >,
    );
    const _ = parsed satisfies JsonifiedEntry<
      RedisStoreCompatibleSpec,
      AnyValidators,
      AnyParams
    >;
    return {
      id: _.id,
      content: _.content,
      vary: _.vary satisfies Vary<AnyParams> as NormalizedVary<Params>,
      validators: _.validators satisfies AnyValidators as Partial<Validators>,
      directives:
        _.directives satisfies ProducerDirectives as NormalizedProducerDirectives,
      initialAge: _.initialAge,
      date: parseDateString(_.date satisfies string as DateString),
    } satisfies Entry<
      RedisStoreCompatibleSpec,
      Validators,
      Params
    > as EntryForId<Spec, Validators, Params, Id>;
  }
}

const noopLogger: Logger = () => {};

/**
 * Encodes a user-supplied id for safe use inside a Redis Cluster hashtag.
 * Characters that would close the hashtag (`{`, `}`) or that have special
 * meaning in our key-shape grammar (`:`) are percent-encoded. Other characters
 * pass through so cache keys remain readable in `redis-cli`.
 *
 * This is NOT a security boundary against a malicious operator with direct
 * Redis access — Redis is binary-safe and any key is legal. It's a hygiene
 * measure to prevent producer-supplied ids from collapsing into the wrong
 * Cluster slot or colliding with our key namespace.
 */
function encodeId(id: string): string {
  let out = "";
  // Iterate by code point (not UTF-16 code unit) so surrogate pairs are
  // handled as a single character. `for…of` walks code points; that lets us
  // pass non-BMP characters to encodeURIComponent in one piece without
  // hitting URIError on a lone surrogate.
  for (const ch of id) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    // Allow printable ASCII except {, }, :, %, and any control char.
    if (
      cp === 0x25 /* % */ ||
      cp === 0x3a /* : */ ||
      cp === 0x7b /* { */ ||
      cp === 0x7d /* } */ ||
      cp < 0x20 ||
      cp === 0x7f
    ) {
      const hex = cp.toString(16).padStart(2, "0").toUpperCase();
      out += `%${hex}`;
    } else if (cp >= 0x80) {
      // Multibyte: round-trip via UTF-8 percent encoding. The full code point
      // (including surrogate pairs as a single character) goes through.
      out += encodeURIComponent(ch);
    } else {
      out += ch;
    }
  }
  return out;
}
