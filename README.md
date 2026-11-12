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

The registry's `matches` guards must **partition the id space**: for every id the cache will ever see (requests, primary results, supplemental results, deletes), exactly one entry must match. `cache.classify(id)` evaluates _every_ guard: zero matches throws `UnclassifiableIdError`, two or more throws `AmbiguousResourceTypeError` — fail loud over first-match-wins, so a registry overlap is caught the first time it occurs. Classification runs on every `get`/`getUnbatched` request id, every stored entry id (primary _and_ supplemental, all validated before anything persists — a producer minting a malformed id can't write a permanently unreadable row), and every `delete` id. Guards should be cheap (prefix checks preferred); ids must carry their type in-band: **an id must be classifiable by inspection**.

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

Without batching, each `cache.get()` makes its own Store call. For `PostgresStore`, that is one query, and one pool connection, per call. Code that fans out one lookup per id, such as a producer client called for each id in a list, therefore runs N queries for N ids. Batching gathers those lookups into one `getMany` call.

A Store declares exactly one read primitive. MemoryStore implements `get(request)`. PostgresStore and SqliteStore implement `getMany(requests)`.
Read through a Cache. The Cache adapts to either primitive, and it publishes diagnostics for each Store read.

`cache.get()` reads one request. With a bulk-capable Store, it joins the automatic accumulation. `cache.getUnbatched()` reads a known set as one Store call, sent promptly. Both accept `{ signal }`. Single-only stores dispatch every read promptly.
Configure the accumulation scheduler with `readBatching`. Its maximum batch size, 20 by default, limits only accumulated reads. Dispatch runs after Promise continuations.

```ts
const cache = new Cache({
  store,
  name: "visits",
  resourceTypes: visitsResourceTypes,
  readBatching: { maxBatchSize: 20, batchScheduleFn: setImmediate },
});
const lookups = await Promise.all(
  requests.map((request) => cache.get(request)),
);
const partial = await cache.getUnbatched(requests);
const complete = throwIfAnyError(partial);
```

- **Requests share one Store call, never one result.** Each `get()` still classifies its own id, evaluates freshness at its own `now`, selects its own entry, and publishes its own `read` message. So a batched `get()` that succeeds returns what an unbatched one returns. Accumulation never caches or shares results, even for identical requests.
- **Scheduling is configurable.** `batchScheduleFn` receives a dispatch callback and must invoke it in the immediate future; for example, pass `setImmediate` to gather reads until the next check phase.
- **The Store call runs in the first caller's async context.** The batch binds the async context (for example, `AsyncLocalStorage` stores and the active tracing span) of the `get()` that opened it, with the default or a custom scheduler. So the query's span appears in that caller's trace only.
- **One request's input can fail other requests.** For example, Postgres rejects a statement that binds an id with U+0000. When the whole Store call fails, every slot in it receives that Error, including other callers' requests.

`getUnbatched()` sends the supplied known set promptly as one call to the Store's bulk primitive. The batch limit does not split it. It does not force individual reads.
Constructor settings control scheduling only. The method a caller picks decides whether a read accumulates.

Bulk reads return positional lookup results or Error slots. Empty entry arrays represent successful misses.
An operational failure of an entire Store call fills every affected slot with the same Error. Cancellation and package contract violations reject the call.
`get` rejects its single Error slot. `throwIfAnyError` waits for no additional work: it throws the first Error from an already-settled result array.

Queued cancellation removes that caller's participation. Cancellation after dispatch ends the caller's wait without aborting shared work, even when every caller cancels.
Duplicate IDs retain separate Store requests and freshness decisions. A bulk call promises neither a transaction nor one database snapshot.

Batching only saves round trips when the Store's `getMany` reads all of its requests in one operation. `PostgresStore` and `SqliteStore` do. A Store that declares only `get` still receives one call per request; see ["Guidelines for Authoring a Store"](./docs/implementing-a-store.md).

Postgres joins indexed request rows against stored entries and filters variants in SQL, so it transfers only matching entries. It runs sequential chunks of at most 1,000 requests (3,000 bound parameters). Duplicate requests can transfer duplicate matching payloads. SQL still evaluates candidate variants, so many variants per ID can increase database work.
Postgres uses the same SQL vary predicate for single and bulk reads, including null-as-absence. Empty stored `vary` matches every request and takes an equality fast path that skips scanning vary fields; null-only vary objects still use the general predicate.
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
Bulk producers accumulate ready requests by default. `producerBatching` controls this separate scheduler, with the same default limit, which applies only to accumulated work, and scheduling convention as Store reads.
Per-call `{ autoBatch: { store: false, producer: false } }` disables accumulation independently at each stage.

Automatic production starts as each independent Store invocation settles. Direct bulk production first classifies the known set. It then sends the call's misses, bypass requests, and stale-while-revalidate refreshes to the producer as one invocation. The batch limit does not split it.
Every producer request must remain valid when requests are added, removed, reordered, split, or deduplicated. Producers must perform side-effect-free reads.
A bulk producer returns one primary result or Error per request. Supplemental resources are stored without adding result slots.

`wrapProducer` treats the cache **`id` as a reference to a mutable entity**: the caller already has the id, and the cached value is whatever that entity currently is — a function of the `id` and time (e.g. "the current `User` for `user:123`"). The id is the natural cache key, so the producer receives it directly.

A **bare producer covers the whole registry**, and the compiler makes it prove that: its parameter must accept every registry id. **Partial coverage requires `producerByIdType`** (or `bulkProducerByIdType`), which turns a per-resource-type record into one function carrying its covered set in an optional symbol-keyed property (`coveredTypes`). That set is the client's **coverage**, and it bounds the client's request type: requests for uncovered types are compile errors (and, if reached via casts, throw `NoProducerForResourceTypeError` _before any cache read_). A bare producer can't under-cover, so that error is unreachable for it. `producerByIdType` throws at construction on an empty record.

Reaching for `producerByIdType` also buys per-branch type checking: each key narrows its sub-producer's `req.id` **and** its result to that resource type's content, so TypeScript checks the (id, content) correlation per branch. A single function's result type is the union over its covered ids, so it is free to return one variant's content for every id.

Both helpers take the **resource-type registry** (`cache.resourceTypes`, or the literal you declared it from) rather than a cache: classifying an id to pick a sub-producer is all they do, and that needs the registry alone. So a by-id-type producer is a value in its own right — buildable, drivable and unit-testable before any cache exists, and reusable across caches over the same registry. It is also the inference site for the registry type, which is why it is a parameter rather than a type argument.

```ts
const getStories = wrapProducer({
  cache,
  produce: producerByIdType(storiesResourceTypes, {
    story: async (req) => ({
      content: await fetchStory(req.id),
      directives: { freshUntilAge: 60 },
    }),
    collection: async (req) => {
      const collection = await fetchCollection(req.id);
      return {
        content: collection,
        directives: { freshUntilAge: 60 },
        // supplementals may target any registry type, covered by this client or not
        supplementalResources: collection.stories.map((s) => ({
          id: `story:${s.id}`,
          content: s,
          directives: { freshUntilAge: 60 },
        })),
      };
    },
  }),
});
```

When such a producer is driven **directly** and an id doesn't classify to exactly one covered type, it throws `UnroutableIdError` — cache-free, carrying `id`, `coveredResourceTypes`, and a `detail` discriminated on `reason` (`"uncovered"` / `"unclassifiable"` / `"ambiguous"`). Driven through a client, the client catches it and re-throws the equivalent cache-named error (`NoProducerForResourceTypeError`, `UnclassifiableIdError`, `AmbiguousResourceTypeError`), so a wrapped producer's observable errors are unchanged. Reaching it through a client at all means the registry the producer was built from disagrees with the cache's own — the client classifies first, against the cache's registry — so passing `cache.resourceTypes` (rather than another object of the same shape) is what keeps the two in step.

Writing a multi-resource-type producer **by hand** instead? `classifyIdAgainst(resourceTypesEntries(resourceTypes), id)` is the same total classification the cache and these helpers use, exported for exactly that, and it returns an outcome rather than throwing so you can render your own errors.

A bare `produceMany` receives the **full** set of requests to produce — mixed resource types and all — in one call, so it can optimize across them (a single upstream call covering several types, cross-type dedup, a join). `bulkProducerByIdType` opts into per-type dispatch instead: it splits the batch by classified resource type, calls each sub-producer once with its own type-pure slice, reassembles the results positionally into the caller's order, and isolates a sub-producer's failure — a rejection or a synchronous throw — into that type's result slots as `Error` elements, so it never discards a sibling type's results.

A type with no producer in any client is legal and normal: its entries are written as other producers' supplemental resources (or direct `store()` calls) and read via `Cache.get` — the serve-if-present contract. Partial coverage also makes capability-scoped and split clients honest: a second `wrapProducer` call can cover a different subset of the same cache.

Both per-resource-type helpers live in [`producerByIdType.ts`](./src/utils/producerByIdType.ts) and [`bulkProducerByIdType.ts`](./src/utils/bulkProducerByIdType.ts) — they need no client at runtime, and no `Cache`. The errors the producer factories raise are in [`producer-errors.ts`](./src/utils/producer-errors.ts).

Compatible requests share pending production for up to three seconds by default. `collapseOverlappingRequestsTime` changes that joining age.
Completed production has no additional sharing window. Compatibility uses the ID, normalized parameters, and directives.
Producers receive original parameters. A normalizer promises that normalized and original parameters have equivalent producer behavior.
If normalization fails during a permitted read-failure fallback, production receives original parameters and does not share work.
Direct callers still join compatible pending work. They dispatch compatible queued work immediately, while unrelated queued requests keep their schedule.

Producers must be **side-effect-free reads of their resource type's origin**: invocations may be shared with concurrent logical callers and their results stored, so producer calls are never 1:1 with callers. Consumers that must reach the origin send bypass directives.
`maxAge: 0` skips Store and pending-entry lookup and requires production. The result is still stored, and identical bypass requests still share production. A producer can return `storeFor: 0` to prevent retention.
Operational read failures call the producer by default. Set `onCacheReadFailure: "throw"` to return Error slots instead; scalar calls reject.
Cancellation and package contract failures never trigger that fallback.

### Producers keyed by original input

`wrapHashedInputProducer` is the "compute" counterpart to `wrapProducer`. Use it when the cached value is not an entity looked up by id but an expensive-to-compute **function of some input** — value = `f(input)`, reused whenever the same input recurs (e.g. an LLM extraction over a chunk of text). Here a hash of the input is the natural cache key, but the producer wants the original, un-hashed input to do the work.

For a cache with one resource type, the two functions are the whole contract — no record, no map, no type arguments:

```ts
const extract = wrapHashedInputProducer({
  cache,
  hashInput: (input: Chunk) =>
    `extract:${sha256(canonicalize(input))}` as const,
  produce: async (input) => ({
    content: await runLlm(input),
    directives: { freshUntilAge: Infinity },
  }),
});
```

For several resource types, [`hashedInputProducerByInputType`](./src/utils/hashedInputProducerByInputType.ts) builds a **hashed-input producer** — one `.when` per covered type, dispatching on the input. It takes **no cache**: a hashed-input producer is a value in its own right, buildable (and reusable) before any cache exists, and checked against a cache's registry only where the two are wired together.

```ts
const hashedInputProducer = hashedInputProducerByInputType<{
  story: HashedInputVariant<StoryInput, Story>;
  collection: HashedInputVariant<CollInput, Story[]>;
}>()
  .when((i): i is StoryInput => i.kind === "story", {
    name: "story",
    hashInput: (input) => `extract:story:${input.id}`, // input: StoryInput
    produce: async (input) => ({
      content: await extractStory(input),
      directives,
    }),
  })
  .when((i): i is CollInput => i.kind === "collection", {
    name: "collection",
    hashInput: (input) => `extract:collection:${input.ids.join(",")}`,
    produce: async (input) => ({
      content: await extractAll(input),
      directives,
    }),
  })
  .build();

const extractTyped = wrapHashedInputProducer({
  cache,
  produce: hashedInputProducer,
});
```

The variant map declares each resource type's input and the content computed from it, so a branch is validated where it is written: `produce` must return that variant's output, `input` is narrowed to that variant's input (no casts), and a second `.when` for an already-covered variant is rejected rather than silently shadowed. `name` selects the variant and the guard is only the runtime dispatcher — which is why two variants may be computed from the _same_ input type (a summary and a translation of one story) and why a guard may prove a _subtype_ of the declared input.

Wiring a producer to a cache is what brings the registry in: each branch's minted-id type is checked against its resource type's id space, each variant's declared output against that type's content, and every variant name against the registry — reported as named, per-branch problems. `hashInput` must mint ids the branch's own registry guard accepts, and that is _also_ checked at runtime by classifying each minted id (naming the branch), which is the backstop for a mint arriving through a cast or an untyped boundary. Each way it can fail gets its own error: the mint matched no resource type (`UnclassifiableIdError`) or several (`AmbiguousResourceTypeError`), or exactly one that isn't the branch's own (`MintedIdResourceTypeMismatchError`, carrying `branch` and `classifiedResourceType` — classification succeeded there, so the mismatch indicts the branch's `hashInput` rather than the registry's guards). For accept-everything registries — a `singleTypeCacheOptions` cache with no `validateId` — the runtime check is vacuous and the compile-time one carries the weight.

The client keeps each input around (reference-counted, so it survives shared production without leaking) just long enough to hand it to `produce` on a miss, and otherwise behaves like a `wrapProducer` client — including call-time consumer `directives` (e.g. `compute.get(input, { directives: { maxAge: 0 } })` forces a recompute). A hashed-input producer may also return `supplementalResources` in two forms: **input-keyed** (`{ input, … }` — routed to a covered branch via the same guard selection as call-time inputs, hashed with that branch's `hashInput`, and mint-checked eagerly, so a later `compute.get(thatInput)` is a hit; in a hashed-input producer the `input` and `content` must come from the SAME variant) or **id-keyed** (`{ id, … }` — a plain resource for _any_ registry type, classified by its own id at store time, exactly like plain producers' supplementals; typing these needs the registry's id space, so a cache-free hashed-input producer must be declared with its `SpecOf` to return them).

For bulk production, `bulkHashedInputProducerByInputType` is the multi-type form: each branch's `produce` computes a batch of that branch's missed inputs and returns a result (or an `Error`) per input, aligned by index.

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

The client returns produced results without awaiting persistence or the callback's return value. Callers own their wait, timeout, retry, and failure policy.
An async callback's returned promise is not awaited or observed; callers must handle their own async work. Caller cancellation does not cancel shared persistence.
Producer errors keep their existing throw, per-item error, and stale-fallback behavior; they are not store failures.

```typescript
let stored = Promise.resolve();
const result = await client.get(request, {
  onStore: (promise) => {
    stored = promise;
  },
});
await stored; // Optional: require persistence before starting subsequent work.
```

Shutdown guarantees differ by store: SQLite drains its writer, while Postgres callers own the database connection and must await persistence before closing it.

### Diagnostics

The package publishes typed `read`, `read-store`, `fetch`, `produce`, and `store-entry` channels from `node:diagnostics_channel`.
V4 removes `Cache.emitter` and its `store` event. Use `cacheStoreEntryChannel` for store diagnostics.
Producer messages require `failedRequestCount`. A resolved bulk invocation can report `outcome: "success"` with failed result slots.
Logical reads and fetches report request outcomes and public-call duration. Physical Store and producer events report actual dispatch duration, request counts, failures, and queue wait.
An operation failure is distinct from its affected logical slots. Bulk producer events can have a `mixed` trigger when requests have different production reasons.
Subscribers must use bounded cache names, resource types, operation kinds, and outcomes for metric tags. Resource IDs belong in traces or logs, not metric tags.

See [`diagnostics.ts`](./src/diagnostics.ts) for the message types. Logical read, fetch, and store-entry messages carry `{ cache, resourceType }` attribution — the cache instance's `name` and the classified resource-type name — so subscribers can build per-cache, per-resource-type metrics with no name threading. (`produce` covers a whole invocation, so it carries `cache` at the top level and each element's `resourceType` inside `requests[]`.) `read-store` messages carry only `cache` because one Store read can mix resource types. Each channel exports its name constant, its message type, and a typed channel object (`TypedChannel`).

| Channel                      | Cardinality                                                                                   | Message highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@zingage/cache:read`        | One per cache lookup (`Cache.get`; per request for `getUnbatched`) — including direct callers | `found`: `"usable"` \| `"usable-while-revalidate"` \| `"usable-if-error"` \| `"none"`, evaluated against the request's directives; plus `vary` — identifying the selected entry's variant — on the three entry-selecting results, and omitted on the others. Bypass requests never appear (they skip the read). A read the store _failed_ publishes `found: "read-failed"` with the `error` — one message per request in the failed call — and _then_ the error propagates, which keeps the channel a total denominator. An **aborted** read emits nothing.                                                                                                                                                    |
| `@zingage/cache:read-store`  | One per actual Store read: automatic or direct                                                | Cache name, Store method, automatic or direct, success/failure/cancellation, dispatched and failed request counts, returned entry count, Store duration, and summed caller queue wait. No resource IDs or payloads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `@zingage/cache:fetch`       | One per logical request to a producer client, at settlement                                   | `disposition`: `served-from-cache`, `served-stale-while-revalidating`, `served-stale-after-error`, `served-from-producer`, `producer-error`, `cache-read-error`, or `aborted`; `collapsed` (the settlement rode an in-flight invocation; cache-served settlements report `false` even when they attached a background revalidation as a rider); cache-served dispositions carry `vary` (identifying the served entry's variant) and producer-path dispositions carry `directivesImpliedBypass`.                                                                                                                                                                                                                |
| `@zingage/cache:produce`     | One per actual producer invocation (foreground misses AND background revalidations)           | `trigger`: `"miss"` \| `"revalidation"` \| `"bypass"` \| `"mixed"` (the invocation's initiating cause; riders never re-label); `requests[]` (`{resourceType, resourceId}`, in the order the producer received them — a bulk batch MAY span resource types, so read each element's own `resourceType`); `collapsedRequestCount` (requests that rode this invocation's tasks instead of starting producer work: 0 for a lone request; a background revalidation that rides counts too, though it has no `fetch` message); `outcome`; `failedRequestCount`; `durationMs`. `failedRequestCount` counts Error slots in a resolved bulk result, or every request if the invocation rejects or violates its contract. |
| `@zingage/cache:store-entry` | One per entry passed to `Cache.store()` (supplementals attributed to their own type)          | `resourceId`, `vary`, `validators`, `relationshipToExistingStoredData` (`"is-new"` \| `"unchanged"` \| `"changed"` \| `undefined`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

A cache's unit of storage is the `(id, vary)` **pair**, where `vary` is the normalized paramName→value map that defines a **variant**: a producer that varies on request params writes one entry per variant under one id. So the three channels that can identify a variant all report the same normalized `vary` object — `store-entry` for the entry written, `read`/`fetch` for the entry a lookup _selected_ — which is what lets a subscriber attribute serves to the exact stored variant (e.g. how many times one version was served before a newer one replaced it) instead of smearing every variant's serves onto whichever variant stored first. Where no variant was served the key is **omitted**, never published as `{}`, because `{}` identifies a real variant — the only one a non-varying producer ever writes. That covers `found: "none"`/`"read-failed"`/`"aborted"` on `read`, and every producer-path disposition on `fetch` — including `served-from-producer`, which did hand the caller a value: that value came from the origin, not a stored variant, and the variant it lands in is reported on `store-entry` if and when the write succeeds.

`served-from-cache` and the other cache-served fetch dispositions can select entries from the client's pending-write overlay. The read channel reports the Store lookup; fetch reports the combined result. A Store miss can therefore lead to a cache-served fetch.

`fetch` and `produce` are the two spans of one story with different subjects and cardinalities: a `fetch` is the consumer-side span (one per logical request); a `produce` is the origin-side span (one per invocation). N collapsed requests ride one invocation, one bulk invocation covers many requests, a stale-while-revalidate refresh settles _after_ its triggering fetch already shipped, and an `aborted` fetch settles _before_ its invocation does (the shared producer call keeps running and stores in the background).

`read-store` covers every actual Store read: automatic batches and direct `Cache.getUnbatched` calls. `operation` identifies the Store method. Empty direct calls and entirely cancelled queued batches emit nothing. `requestCount` counts dispatched slots, including duplicates. `failedRequestCount` counts Error slots, or every request on whole-operation failure. `entryCount` counts entries in successful slots, even when another slot fails; whole-operation failures report zero entries. `queueWaitTotalMs / requestCount` gives mean dispatched caller queue wait; direct calls report zero. `durationMs` covers the Store call, not database execution time or a physical query count: a Store may issue multiple queries or use no database.

The package does not calculate returned payload bytes, serialize values for telemetry, choose metric tags, or create monitors. Subscribers own aggregation and telemetry costs.

Upgrading from 1.6.0, whose single channel reported a `status` string: `hit` → `served-from-cache`, `stale_while_revalidate` → `served-stale-while-revalidating`, and `miss`/`bypass` → `served-from-producer` (now distinguished by `directivesImpliedBypass`).

### Migrating from v3

- Rename `@zingage/cache:read-batch` subscriptions to `@zingage/cache:read-store`. Use `CACHE_READ_STORE_CHANNEL_NAME`, `cacheReadStoreChannel`, and `CacheReadStoreMessage`; v4 provides no old-name aliases.

- Replace `batchReads` with `readBatching`. Remove constructor participation flags.
- Move the second `wrapProducer` argument into `produce`; move `wrapBulkProducer` producers into `produceMany` on `wrapProducer`.
- Replace callable wrappers with `client.get` or `client.getMany`.
- Replace `wrapBulkHashedInputProducer` with `wrapHashedInputProducer` and move its capability into `produceMany`.
- Move typed `hashedInputProducer` descriptors into the matching capability field.
- Handle bulk Error slots or explicitly call `throwIfAnyError`.
- Replace `Cache.getMany(requests)` with `Cache.get` for each request, so that reads from many calls share Store calls. Use `Cache.getUnbatched(requests)` instead for a known set when you don't want batching: it sends the set as one Store call.
- Replace `CacheReadFound` with `CacheReadMessage["found"]`. Narrow on `found` instead of using `CacheReadFoundWithEntry`.
- Read through a Cache instead of reading a Store directly. The package no longer exports `getOne`, `getMany`, or `naiveGetMany`.
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
See [store shutdown details](docs/implementing-a-store.md#store-shutdown).
