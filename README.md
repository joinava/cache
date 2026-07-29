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

Every `Cache` is built over a **resource-type registry** ([`ResourceTypes`](./src/types/00_ResourceTypes.ts)): a record naming each *kind* of resource the cache can hold, pairing a runtime classifier for that kind's id sub-space (`matches`) with its content type (a type-level phantom). Both constructor options are required:

```ts
const storiesResourceTypes = {
  story: resourceType<Story>()({ matches: idStartsWith("story:") }),
  collection: resourceType<Story[]>()({ matches: idStartsWith("collection:") }),
} satisfies ResourceTypes;

const cache = new Cache(store, {
  name: "stories", // names this cache instance in every diagnostics message
  resourceTypes: storiesResourceTypes,
});
```

The registry's `matches` guards must **partition the id space**: for every id the cache will ever see (requests, primary results, supplemental results, deletes), exactly one entry must match. `cache.classify(id)` evaluates *every* guard: zero matches throws `UnclassifiableIdError`, two or more throws `AmbiguousResourceTypeError` — fail loud over first-match-wins, so a registry overlap is caught the first time it occurs. Classification runs on every `get`/`getMany` request id, every stored entry id (primary *and* supplemental, all validated before anything persists — a producer minting a malformed id can't write a permanently unreadable row), and every `delete` id. Guards should be cheap (prefix checks preferred); ids must carry their type in-band: **an id must be classifiable by inspection**.

Single-type caches can use `soleResourceType`:

```ts
const cache = new Cache(store, {
  name: "zendesk_ticket_schemas",
  resourceTypes: {
    ticket_schema: soleResourceType<TicketSchema, `zendesk-ticket-schema:${string}`>(),
  },
});
```

Its runtime guard is trivially true (classification never fails on a sole-type cache), while the optional second type argument still narrows the id space *at the type level* — template-literal and branded ids flow through to every request, producer, and entry type. When runtime enforcement is wanted too, write the one-entry registry with a real guard instead.

### Per-id content typing (heterogeneous caches)

The cache's [`CacheSpec`](./src/types/00_CacheSpec.ts) union — which pairs each `id` type with the corresponding `content` type — is **derived from the registry** via `SpecOf`, so the two can never drift:

```ts
type StoriesCacheSpec = SpecOf<typeof storiesResourceTypes>;
// = CacheSpec<`story:${string}`, Story> | CacheSpec<`collection:${string}`, Story[]>

// Per-id content narrowing on read:
const storyRes = await cache.get({ id: "story:1", params: {}, directives: {} });
//    storyRes.usable?.content has type `Story | undefined`
const collRes = await cache.get({ id: "collection:top", params: {}, directives: {} });
//    collRes.usable?.content has type `Story[] | undefined`

// The (id, content) pair is also enforced on write:
await cache.store([
  { id: "story:1", content: aStory, directives: { freshUntilAge: 60 } },           // ok
  { id: "collection:top", content: [story1, story2], directives: { freshUntilAge: 60 } }, // ok
  // @ts-expect-error -- can't store a Story[] under a story:* id
  { id: "story:bad", content: [story1], directives: { freshUntilAge: 60 } },
]);
```

This is particularly useful when a producer that fetches a collection wants to additionally cache each individual entry (via `supplementalResources`), so that point lookups for each entry by id can also be served by the same cache.

## Key Files

- [`Cache.ts`](./src/Cache.ts): this defines the basic cache class. Note that the class's job is just to return whether/which previously-stored responses are usable to satisfy an incoming request. It does not handle things like making requests to the producer for new responses when no cached response is usable.

- [`MemoryStore.ts`](./src/stores/MemoryStore/MemoryStore.ts): a store for retaining cached data in memory, with a TTL and optional LRU eviction to cap memory usage.

- [`PostgresStore.ts`](./src/stores/PostgresStore/PostgresStore.ts): a store for retaining cached data in Postgres.

The package provides **four** functions for wrapping producers with a cache. They split along two axes — single vs. bulk, and "lookup" vs. "compute" — and all four take their producers as a **record with one entry per covered resource type**:

- [`wrapProducer.ts`](./src/utils/wrapProducer.ts) — **`wrapProducer`**: the package's most important export, arguably. It takes producers (functions that return data to cache, one per covered resource type) and a `Cache` instance, and returns a function that will use a cached value when a suitable one is available, but otherwise classify the request's id, call through to *that resource type's* producer, and store its return value for future requests.

  ```ts
  const getStories = wrapProducer(cache, {}, {
    story: async (req) => ({ content: await fetchStory(req.id), directives: { freshUntilAge: 60 } }),
    collection: async (req) => {
      const collection = await fetchCollection(req.id);
      return {
        content: collection,
        directives: { freshUntilAge: 60 },
        // supplementals may target any registry type, covered by this wrapper or not
        supplementalResources: collection.stories.map((s) => ({ id: `story:${s.id}`, content: s, directives: { freshUntilAge: 60 } })),
      };
    },
  });
  ```

  The record's keys are inferred as the wrapper's **coverage** — any non-empty subset of the registry — and bound the returned function's request type: requests for uncovered types are compile errors (and, if reached via casts, throw `NoProducerForResourceTypeError` *before any cache read*). A type with no producer in any wrapper is legal and normal: its entries are written as other producers' supplemental resources (or direct `store()` calls) and read via `Cache.get` — the serve-if-present contract. Partial coverage also makes capability-scoped and split wrappers honest: a second `wrapProducer` call can cover a different subset of the same cache. There is **no bare-function form** — even sole-type caches write `{ <type-name>: producer }` (a keyless record throws at construction time).

  Producers must be **side-effect-free reads of their resource type's origin**: invocations may be collapsed (shared with concurrent logical callers) and their results stored, so producer calls are never 1:1 with callers. Consumers that must reach the origin send bypass directives (`maxAge: 0`) — which skip the cache read entirely, guaranteeing producer contact (the result is still stored, and identical bypass requests still collapse). Producers whose response must not be stored return `storeFor: 0`.

- [`wrapBulkProducer.ts`](./src/utils/wrapBulkProducer.ts) — **`wrapBulkProducer`**: the same idea for producers that resolve many requests at once. It looks each request up in the cache and calls the underlying producers only for the ones that missed (or need background revalidation), grouping requests by classified resource type — one bulk call per type per collapse window; a batch never mixes types.

  `wrapProducer` and `wrapBulkProducer` both treat the cache **`id` as a reference to a mutable entity**: the caller already has the id, and the cached value is whatever that entity currently is — a function of the `id` and time (e.g. "the current `User` for `user:123`"). The id is the natural cache key, so the producers receive it directly.

- [`wrapComputingProducer.ts`](./src/utils/wrapComputingProducer.ts) — **`wrapComputingProducer`** and **`wrapBulkComputingProducer`**: the "compute" counterparts to the two above, for when the cached value is not an entity looked up by id but an expensive-to-compute **function of some input** — value = `f(input)`, reused whenever the same input recurs (e.g. an LLM extraction over a chunk of text). Here a hash of the input is the natural cache key, but the producer wants the original, un-hashed input to do the work.

  You pass `(cache, options, branches)`, where `branches` has one entry per covered resource type: `{ matchesInput?, hashInput, produce }`. `hashInput` derives the branch's cache ids from its inputs (and must mint ids that the branch's own registry guard accepts — checked at runtime by classifying each minted id, vacuous for `soleResourceType` registries where the compile-checked return type is the line of defense). `matchesInput` routes each incoming input to its branch; it's required when the wrapper covers more than one type and ignored when it covers exactly one. The wrapper keeps each input around (reference-counted, so it survives request collapsing without leaking) just long enough to hand it to `produce` on a miss, and otherwise behaves like `wrapProducer`/`wrapBulkProducer` — including call-time consumer `directives` (e.g. `compute(input, { directives: { maxAge: 0 } })` forces a recompute). A computing producer may also return `supplementalResources` in two forms: **input-keyed** (`{ input, … }` — routed to a covered branch via the same `matchesInput` selection as call-time inputs, hashed with that branch's `hashInput`, and mint-checked eagerly, so a later `compute(thatInput)` is a hit) or **id-keyed** (`{ id, … }` — a plain resource for *any* registry type, classified by its own id at store time, exactly like plain producers' supplementals).

  ```ts
  const extract = wrapComputingProducer(cache, {}, {
    extraction: {
      hashInput: (input: Chunk) => `extract:${sha256(canonicalize(input))}` as const,
      produce: async (input) => ({ content: await runLlm(input), directives: { freshUntilAge: Infinity } }),
    },
  });
  ```

## Diagnostics channels

The package publishes telemetry on four [`diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html) channels (see [`diagnostics.ts`](./src/diagnostics.ts)). Every message carries `{ cache, resourceType }` attribution — the cache instance's `name` and the classified resource-type name — so subscribers can build per-cache, per-resource-type metrics with no name threading. Each channel exports its name constant, its message type, and a typed channel object (`TypedChannel`).

| Channel                       | Cardinality                                                                             | Message highlights                                                                                                                                                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@zingage/cache:read`        | One per cache lookup (`Cache.get`; per request for `getMany`) — including direct callers | `found`: `"usable"` \| `"usable-while-revalidate"` \| `"usable-if-error"` \| `"none"`, evaluated against the request's directives. Bypass requests never appear (they skip the read); a read the store failed emits nothing (the error propagates).                        |
| `@zingage/cache:fetch`       | One per call of a wrapped producer (per request element, for bulk), at settlement        | `disposition`: `served-from-cache`, `served-stale-while-revalidating`, `served-stale-after-error`, `served-from-producer`, `producer-error`, or `aborted`; `collapsed` (the settlement rode an in-flight invocation; cache-served settlements report `false` even when they attached a background revalidation as a rider); producer-path dispositions carry `directivesImpliedBypass`.       |
| `@zingage/cache:produce`     | One per actual producer invocation (foreground misses AND background revalidations)      | `trigger`: `"miss"` \| `"revalidation"` \| `"bypass"` (the invocation's initiating cause; riders never re-label); `requests[]` (`{resourceType, resourceId}`, all one type); `collapsedCallerCount`; `outcome`; `durationMs`. Producer latency and error rate live here. |
| `@zingage/cache:store-entry` | One per entry passed to `Cache.store()` (supplementals attributed to their own type)     | `resourceId`, `vary`, `validators`, `relationshipToExistingStoredData` (`"is-new"` \| `"unchanged"` \| `"changed"` \| `undefined`).                                                                                                                                       |

`fetch` and `produce` are the two spans of one story with different subjects and cardinalities: a `fetch` is the consumer-side span (one per logical request); a `produce` is the origin-side span (one per invocation). N collapsed callers ride one invocation, one bulk invocation covers many requests, a stale-while-revalidate refresh settles *after* its triggering fetch already shipped, and an `aborted` fetch settles *before* its invocation does (the collapsed producer call keeps running and stores in the background).
