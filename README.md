# cache

## Package Contents

This package provides a class, [`Cache`](./src/Cache.ts), that implements caching using a model inspired by [HTTP's](https://datatracker.ietf.org/doc/html/rfc9111). The HTTP model is already incredibly powerful, and this class generalizes and extends it further in some ways.

Even though this package borrows ideas from HTTP, it can be used to cache any kind of data from any source, not just HTTP responses. Its implementation assumes no HTTP particulars (like specific header formats).

Still, you must understand a number of concepts from HTTP's caching model in order to use this package effectively. Those are explained in ["Caching Model"](./docs/caching-model.md). Please read that, or many of the names and APIs in this package won't make sense.

### Backing stores

The `Cache` class can only function with a "backing store" that actually holds the cache's entries. There is a common `Store` interface (see the [types file](./src/types/06_Store.ts)) that all stores must implement. We currently have three backing stores, one that [holds items in memory](./src/stores/MemoryStore/MemoryStore.ts); one that [stores items in Postgres](./src/stores/PostgresStore/PostgresStore.ts); and one that [uses Sqlite](./src/stores/SqliteStore/SqliteStore.ts).

Note that not all backing stores will be able to store all kinds of data, although it's recommended that general-purpose stores be able to store any data that's JSON-serializable. Store implementations can communicate the type of data they support by adding a constraint on their first type parameter, e.g., a store with the signature `class MyStore<Spec extends CacheSpec<string, string[]>, ...>` is indicating that it can only store string arrays. Trying to use a store with a `Cache` instance parameterized for entries of different types will yield a type error.

Stores never see resource-type names or classification (below); those are entirely a `Cache` concern, so any `Store` implementation works unchanged.

### The resource-type registry

Every `Cache` is built over a **resource-type registry** ([`ResourceTypes`](./src/types/00_ResourceTypes.ts)): a record naming each _kind_ of resource the cache can hold, pairing a runtime classifier for that kind's id sub-space (`matches`) with its content type (a type-level phantom). `Cache` takes a single options bag; `store`, `name` and `resourceTypes` are all required:

```ts
const storiesResourceTypes = {
  story: resourceType<Story>()({ matches: idStartsWith("story:") }),
  collection: resourceType<Story[]>()({ matches: idStartsWith("collection:") }),
} satisfies ResourceTypes;

const cache = new Cache({
  store: store,
  name: "stories", // names this cache instance in every diagnostics message
  resourceTypes: storiesResourceTypes,
});
```

The registry's `matches` guards must **partition the id space**: for every id the cache will ever see (requests, primary results, supplemental results, deletes), exactly one entry must match. `cache.classify(id)` evaluates _every_ guard: zero matches throws `UnclassifiableIdError`, two or more throws `AmbiguousResourceTypeError` — fail loud over first-match-wins, so a registry overlap is caught the first time it occurs. Classification runs on every `get`/`getMany` request id, every stored entry id (primary _and_ supplemental, all validated before anything persists — a producer minting a malformed id can't write a permanently unreadable row), and every `delete` id. Guards should be cheap (prefix checks preferred); ids must carry their type in-band: **an id must be classifiable by inspection**.

A cache with exactly **one** resource type doesn't have to name it — `singleTypeCacheOptions` builds the whole options bag, naming the type after the cache (override with `resourceTypeName`):

```ts
const cache = new Cache(
  singleTypeCacheOptions<TicketSchema>()({
    store,
    name: "zendesk_ticket_schemas",
  }),
);
```

By default its sole type accepts every id, so classification never fails and the id space is `string`. Spread the result to set anything else `CacheOptions` accepts. The one thing it gives up is precision of the resource-type _name_: `classify()` returns `string` rather than a literal, which is the point of not having to pick one.

To narrow the id space below `string` — template-literal or branded ids flowing through to every request, producer, and entry type — pass a **real guard** as `validateId`:

```ts
const cache = new Cache(
  singleTypeCacheOptions<TicketSchema>()({
    store,
    name: "zendesk_ticket_schemas",
    validateId: idStartsWith("zendesk-ticket-schema:"),
  }),
);
```

`validateId` is _required_ as soon as the id space is narrower than `string`, so a narrowed id type always has a runtime check behind it — naming a narrow `Id` by explicit type argument without supplying the guard is a compile error. The store needs no type argument to earn the narrowing: `Id` comes from the guard alone, and the store is only checked for coverage (see below).

Writing the one-entry registry out by hand stays equivalent, and is the better choice when you also want the literal resource-type name:

```ts
const cache = new Cache({
  store,
  name: "zendesk_ticket_schemas",
  resourceTypes: {
    ticket_schema: resourceType<TicketSchema>()({
      matches: idStartsWith("zendesk-ticket-schema:"),
    }),
  },
});
```

### The store may support more types than the cache

`Store` is invariant in its `Spec` — `Spec` appears both in `store()`/`delete()`'s parameters and in `get()`/`getMany()`'s return types — so a `Store<Wide>` is not assignable to a `Store<Narrow>`, even though for any id the narrow cache actually asks for, the wide store returns exactly the same thing. Since most stores are general-purpose, requiring an exact match would mean re-instantiating them with artificially narrowed type arguments.

So the cache doesn't require a match: it captures the store's own spec and only checks that it **covers** the registry. A general-purpose store just works, with no type arguments and no narrowing:

```ts
const store = new MemoryStore<SpecOf<typeof everyResourceTypeWeHave>>();
const cache = new Cache({
  store,
  name: "stories",
  resourceTypes: storiesResourceTypes,
});
```

A store that does _not_ cover the registry is still rejected, so this convenience can't silently accept a store that would fail at runtime on an id it doesn't handle. The same rule applies to `singleTypeCacheOptions`, so one general-purpose store can back several single-type caches:

```ts
const store = new MemoryStore<SpecOf<typeof everyResourceTypeWeHave>>();
const tickets = new Cache(
  singleTypeCacheOptions<TicketSchema>()({
    store,
    name: "zendesk_ticket_schemas",
    validateId: idStartsWith("zendesk-ticket-schema:"),
  }),
);
```

Nothing about the wider store leaks into the narrow cache: `tickets` still accepts only `zendesk-ticket-schema:` ids and still returns `TicketSchema`, not the store's content union.

### Per-id content typing (heterogeneous caches)

The cache's [`CacheSpec`](./src/types/00_CacheSpec.ts) union — which pairs each `id` type with the corresponding `content` type — is **derived from the registry** via `SpecOf`, so the two can never drift:

```ts
type StoriesCacheSpec = SpecOf<typeof storiesResourceTypes>;
// = CacheSpec<`story:${string}`, Story> | CacheSpec<`collection:${string}`, Story[]>

// Per-id content narrowing on read:
const storyRes = await cache.get({ id: "story:1", params: {}, directives: {} });
//    storyRes.usable?.content has type `Story | undefined`
const collRes = await cache.get({
  id: "collection:top",
  params: {},
  directives: {},
});
//    collRes.usable?.content has type `Story[] | undefined`

// The (id, content) pair is also enforced on write:
await cache.store([
  { id: "story:1", content: aStory, directives: { freshUntilAge: 60 } }, // ok
  {
    id: "collection:top",
    content: [story1, story2],
    directives: { freshUntilAge: 60 },
  }, // ok
  // @ts-expect-error -- can't store a Story[] under a story:* id
  { id: "story:bad", content: [story1], directives: { freshUntilAge: 60 } },
]);
```

This is particularly useful when a producer that fetches a collection wants to additionally cache each individual entry (via `supplementalResources`), so that point lookups for each entry by id can also be served by the same cache.

### Read capabilities and batching

A Store declares exactly one read primitive. MemoryStore implements `get(request)`. PostgresStore and SqliteStore implement `getMany(requests)`.
The exported `getOne(store, request)` and `getMany(store, requests)` adapters support either capability without accumulating calls.

Both Cache methods accept `{ signal, autoBatch?: false }`. Bulk-capable stores accumulate calls by default; single-only stores dispatch promptly.
Configure the accumulation scheduler with `readBatching`. The default maximum batch size is 20. Dispatch runs after Promise continuations.

```ts
const cache = new Cache({
  store,
  name: "visits",
  resourceTypes: visitsResourceTypes,
  readBatching: { maxBatchSize: 20, batchScheduleFn: setImmediate },
});
const partial = await cache.getMany(requests);
const complete = throwIfAnyError(partial);
await cache.getMany(requests, { autoBatch: false });
```

`autoBatch: false` dispatches the supplied known set promptly through the Store's bulk primitive. It does not force individual reads.
Only `false` is an explicit override. Constructor settings control scheduling, not participation defaults.

Bulk reads return positional lookup results or Error slots. Empty entry arrays represent successful misses.
An operational failure of an entire Store call fills every affected slot with the same Error. Cancellation and package contract violations reject the call.
`get` rejects its single Error slot. `throwIfAnyError` waits for no additional work: it throws the first Error from an already-settled result array.

Queued cancellation removes that caller's participation. Cancellation after dispatch ends the caller's wait without aborting shared work, even when every caller cancels.
Duplicate IDs retain separate Store requests and freshness decisions. A bulk call promises neither a transaction nor one database snapshot.

Postgres joins indexed request rows against stored entries and filters variants in SQL. It runs sequential chunks of at most 1,000 requests.
SQLite fetches candidate variants and filters them in its worker. Both stores preserve complete successful slots when another slot or SQL chunk fails.
They continue later SQL chunks without individual retries. Each Store invocation resolves one complete array; it does not stream completed chunks.

SQL text bindings replace lone UTF-16 surrogates in IDs with U+FFFD. Both SQL stores compare returned IDs exactly with the original request, so ill-formed IDs produce misses rather than hits for a different ID. SQLite also checks the ID preserved in entry JSON: an ill-formed stored ID cannot be served under its well-formed replacement. Such writes can collide at the SQL key and evict another entry. MemoryStore preserves IDs exactly. SQLite preserves string vary keys and values through JSON and compares them exactly; Postgres rejects ill-formed strings in persisted JSONB and in both single and bulk JSONB params. An unused request param does not prevent an otherwise valid match.

## Key Files

- [`Cache.ts`](./src/Cache.ts): this defines the basic cache class. Note that the class's job is just to return whether/which previously-stored responses are usable to satisfy an incoming request. It does not handle things like making requests to the producer for new responses when no cached response is usable.

- [`MemoryStore.ts`](./src/stores/MemoryStore/MemoryStore.ts): a store for retaining cached data in memory, with a TTL and optional LRU eviction to cap memory usage.

- [`PostgresStore.ts`](./src/stores/PostgresStore/PostgresStore.ts): a store for retaining cached data in Postgres.

The package provides two producer factories. Each returns a client with `get`, `getMany`, and `close`.

### Producers keyed by resource ID

```ts
const visits = wrapProducer({
  cache,
  produce: async (request) => ({
    content: await fetchVisits(request.id),
    directives: { freshUntilAge: 60 },
  }),
});
await visits.get({ id: "visit:1" });

const stories = wrapProducer({
  cache,
  produceMany: bulkProducerByIdType(storiesResourceTypes, producersByType),
  producerBatching: { maxBatchSize: 20 },
});
const results = await stories.getMany(requests, {
  autoBatch: { store: false },
});
```

Declare exactly one top-level capability: `produce` or `produceMany`. Single producers dispatch promptly.
Bulk producers accumulate ready requests by default. `producerBatching` controls this separate scheduler, with the same default limit and scheduling convention as Store reads.
Per-call `{ autoBatch: { store: false, producer: false } }` disables accumulation independently at each stage.

Automatic production starts as each independent Store invocation settles. Direct bulk production first classifies the known set, then dispatches its foreground cohort, subject to the batch limit.
Every producer request must remain valid when requests are added, removed, reordered, split, or deduplicated. Producers must perform side-effect-free reads.
A bulk producer returns one primary result or Error per request. Supplemental resources are stored without adding result slots.

A bare producer covers the whole registry. `producerByIdType` and `bulkProducerByIdType` declare narrower coverage and check branch-specific content types.
They accept the registry without requiring a Cache. Requests outside declared coverage fail before Store reads.
The bulk helper groups requests by resource type and preserves positional results, including errors from individual branches.

Compatible requests share pending production for up to three seconds by default. `collapseOverlappingRequestsTime` changes that joining age.
Completed production has no additional sharing window. Compatibility uses the ID, normalized parameters, and directives.
Producers receive original parameters. A normalizer promises that normalized and original parameters have equivalent producer behavior.
If normalization fails during a permitted read-failure fallback, production receives original parameters and does not share work.
Direct callers still join compatible pending work. They dispatch compatible queued work immediately, while unrelated queued requests keep their schedule.

`maxAge: 0` skips Store and pending-entry lookup and requires production. A producer can return `storeFor: 0` to prevent retention.
Operational read failures call the producer by default. Set `onCacheReadFailure: "throw"` to return Error slots instead; scalar calls reject.
Cancellation and package contract failures never trigger that fallback.

### Producers keyed by original input

```ts
const compute = wrapHashedInputProducer({ cache, hashInput, produce });
await compute.get(input);
await compute.getMany(inputs, { directives: { maxAge: 0 } });

const grouped = wrapHashedInputProducer({
  cache,
  produceMany: bulkHashedInputProducerByInputType<Variants>()
    .when(matchesInput, { name: "result", hashInput, produce: produceBatch })
    .build(),
});
```

Typed helper descriptors belong under the matching `produce` or `produceMany` field. They carry their branch hash functions; do not supply another `hashInput`.
The wrapper checks minted IDs against the Cache registry. Input-keyed supplementals route through the same branch guards and hash functions.
ID-keyed supplementals can target any registry type. The wrapper retains original inputs until queued or dispatched production no longer needs them.

### Pending writes and persistence

Both clients return produced values before persistence finishes. Eligible primary and supplemental entries remain available while their writes are pending.
Every ordinary lookup consults the Store and merges its results with a retained pending snapshot. Canonical freshness and variant rules select the result.
Newer persisted entries can win; equal birth dates prefer pending entries. The overlay models all retention-eligible candidates, including duplicate slots.
A backing Store can retain fewer entries because of eviction, capacity, or deduplication. The overlay removes entries when writes succeed or fail.

Pass `onStore(stored)` to observe foreground persistence. The callback runs once before a successful public call returns.
Its promise waits for every relevant write, then rejects with the first failure in request order. Ignoring it does not cause an unhandled rejection.
A pending-entry hit or stale fallback observes the selected entry's original write. A stale return excludes its new background refresh.
Cache hits without pending writes and empty bulk calls receive a fulfilled promise. A synchronous callback failure rejects the public call.

### Diagnostics

The package publishes typed `read`, `read-batch`, `fetch`, `produce`, and `store-entry` channels from `node:diagnostics_channel`.
V4 removes `Cache.emitter` and its `store` event. Use `cacheStoreEntryChannel` for store diagnostics.
Producer messages require `failedRequestCount`. A resolved bulk invocation can report `outcome: "success"` with failed result slots.
Logical reads and fetches report request outcomes and public-call duration. Physical Store and producer events report actual dispatch duration, request counts, failures, and queue wait.
An operation failure is distinct from its affected logical slots. Bulk producer events can have a `mixed` trigger when requests have different production reasons.
Subscribers must use bounded cache names, resource types, operation kinds, and outcomes for metric tags. Resource IDs belong in traces or logs, not metric tags.

### Migrating from v3

- Replace `batchReads` with `readBatching`. Remove constructor participation flags.
- Move the second `wrapProducer` argument into `produce`; move `wrapBulkProducer` producers into `produceMany` on `wrapProducer`.
- Replace callable wrappers with `client.get` or `client.getMany`.
- Replace `wrapBulkHashedInputProducer` with `wrapHashedInputProducer` and move its capability into `produceMany`.
- Move typed `hashedInputProducer` descriptors into the matching capability field.
- Handle bulk Error slots or explicitly call `throwIfAnyError`.
- Replace direct Store reads with its declared primitive or the exported adapters.
- Close all clients before their shared Cache, then close externally owned producer dependencies and database pools.

## Mutation ordering

Overlapping `store()` and `delete()` calls have no ordering guarantee, including calls on the same cache or store instance. Await a mutation before starting the next mutation when their order matters. MemoryStore writes also require awaiting completion before a caller can rely on their visibility. A completed delete does not prevent an in-flight producer from storing its result later. Cross-request invalidation needs a separate version or generation protocol; these APIs do not provide one.

## Store shutdown

Close producer clients first. Their `close()` rejects new calls, flushes queues, and drains accepted reads, production, background refreshes, and writes.
Accepted reads can still start production while the client drains. Cache close then drains accepted Store operations before invoking Store cleanup.
SQLite releases its workers after accepted work and its writer checkpoint finish. MemoryStore stops its expiration timer. Postgres leaves the externally owned pool open.

All close methods take no timeout. Repeated calls observe the same drain. Operational read, producer, and persistence failures stay on their original results and diagnostics.
Close reports lifecycle or cleanup failures; it does not replay operation failures. Await `onStore` when successful persistence matters.
The application owns its process deadline. Deadline expiry does not prove graceful completion or make dependencies safe to close.
