# Changelog

Dates below are npm publication dates (UTC). Version 4.0.0 is unreleased.

## 4.0.0 — Unreleased

### Breaking changes

- Stores declare exactly one read capability: `get` or `getMany`. Use the
  exported `getOne` and `getMany` adapters to read either kind of Store.
- Bulk Cache reads return positional results containing successes or `Error`
  values. Handle each slot or use `throwIfAnyError` to reject partial failure.
- Replace `batchReads` with `readBatching`. Both Cache read methods now support
  `{ autoBatch: false }` to bypass automatic accumulation.
- `wrapProducer` and `wrapHashedInputProducer` return clients with `get`,
  `getMany`, and `close`, replacing callable wrappers. Declare exactly one
  top-level capability, `produce` or `produceMany`, in the options object.
  Replace `wrapBulkProducer` and `wrapBulkHashedInputProducer` with these
  factories; move typed hashed-input descriptors into the capability field.
- Rename the `@zingage/cache:read-batch` diagnostics channel to
  `@zingage/cache:read-store`, with exports `CACHE_READ_STORE_CHANNEL_NAME`,
  `cacheReadStoreChannel`, and `CacheReadStoreMessage`. No aliases are provided.
- Remove `Cache.emitter` and its `store` event. Observe Store writes through
  `cacheStoreEntryChannel`.
- Close producer clients before their shared Cache, then close externally
  owned dependencies. Shutdown drains accepted work without an implicit
  timeout; applications own their shutdown deadline.

### Features and fixes

- Separate Store-read and producer queues automatically batch bulk-capable
  operations, with a default maximum batch size of 20. Single-only
  capabilities dispatch promptly. Wrapper calls can disable Store and
  producer accumulation independently with `autoBatch` options.
- Compatible pending requests share producer work across calls. Producers
  receive original parameters; normalized parameters determine compatibility.
- Postgres and SQLite preserve successful request slots when another request
  or SQL chunk fails, and continue later chunks without retrying failed ones.
- Diagnostics distinguish logical duration, queue wait, and physical work;
  producer messages include `failedRequestCount` and Store-read messages
  identify automatic batching.
- Client and Cache shutdown drain accepted reads, production, background
  refreshes, and persistence before cleanup.

See the [v3 migration guide](README.md#migrating-from-v3),
[Store implementation guide](docs/implementing-a-store.md), and
[v4 design](docs/plans/2026-11-06-cache-v4-api.md) for details.
Storage formats and database schemas are unchanged.

## 3.4.0 — 2026-11-07

- Add logical read latency and physical Store-operation diagnostics, including
  request counts, failures, dispatch duration, and queue wait.

## 3.3.0 — 2026-11-06

- Add `onStore` to producer wrappers so callers can observe and await foreground
  persistence.
- Allow per-request `Error` results from `Store.getMany`.
- Treat pending Store writes as cache hits in ordinary and hashed-input
  producer wrappers, avoiding duplicate production while persistence runs.

## 3.2.0 — 2026-11-06

- Yield cooperatively during large bulk operations and split large writes
  into bounded batches to improve event-loop responsiveness.
- Preserve change-detection results while processing writes in batches.
- Clarify mutation visibility, overlapping mutation ordering, and Store
  shutdown behavior.

## 3.1.0 — 2026-11-03

- Add configurable automatic Cache read batching with `batchReads`, enabled
  by default and backed by DataLoader.
- Batch Postgres reads into queries of up to 1,000 IDs and apply variant
  filtering in SQL.
- Require exact SQL ID matches to avoid Unicode collision hits; fix SQLite
  bulk lookup of lone-surrogate IDs.
- Preserve reader context during forced batch dispatch and avoid argument
  spread limits when flattening large Postgres results.

## 3.0.1 — 2026-08-18

- Declare `debug` as a runtime dependency.
- Correct published package contents and dependency declarations, excluding
  compiled tests and keeping `tagged-tag` development-only.
- Type Postgres pools with Kysely's `PostgresPool`, avoiding a consumer
  requirement for `@types/pg`.

## 3.0.0 — 2026-08-04

- **Breaking:** include variant information in read/fetch diagnostics and adopt
  readonly-first request types.
- Export additional public types.

## 2.0.1 — 2026-07-31

- Export `PostgresStoreCompatibleSpec` and `JSONWithUndefined`.

## 2.0.0 — 2026-07-30

- **Breaking:** introduce a resource-type registry, derived resource specs,
  redesigned diagnostics, and one Cache options object with ID validation.
- **Breaking:** producer wrappers take one producer function with the Cache
  supplied in their options. Add resource-type-aware producer builders and
  explicit coverage for producers supporting a subset of resource types.
- **Breaking:** rename computing producers to hashed-input producers and
  provide cache-independent hashing producer descriptors.
- Harden producer guard classification, synchronous error handling, result
  counts, and shutdown. Preserve directives and supplemental-resource support
  in hashed-input wrappers.

## 1.6.0 — 2026-07-27

- Report Store entry change-detection results and relationships, with public
  result types and Store-entry diagnostics.
- Improve in-call deduplication, JSON validation, and Postgres upsert ordering.
- Expose typed diagnostics-channel unsubscription and public channel APIs.

## 1.4.0 — 2026-06-25

- Add computing producer wrappers for caching by hashed input, including bulk
  production and input-keyed supplemental resources.
- Support infinite freshness values through JSON-based Stores; reject or
  drop invalid directive values during normalization.
- Add RedisStore scaffolding.

## 1.3.0 — 2026-05-16

- Add `SqliteStore`, including worker-backed reads and writes.
- Support caches whose content type depends on the resource ID.

## 1.2.0 — 2026-05-01

- Add `AbortSignal` support.

## 1.1.0 — 2026-02-10

- Integrate cache lifecycle with asynchronous disposal.
- Fix published type compatibility.

## 1.0.1 — 2026-01-15

- Fix Postgres writes containing duplicate entries and update published file
  selection.

## 1.0.0 — 2026-01-15

- Initial release.
