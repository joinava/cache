# cache

## Package Contents

This package provides a class, [`Cache`](./src/Cache.ts), that implements caching using a model inspired by [HTTP's](https://datatracker.ietf.org/doc/html/rfc9111). The HTTP model is already incredibly powerful, and this class generalizes and extends it further in some ways.

Even though this package borrows ideas from HTTP, it can be used to cache any kind of data from any source, not just HTTP responses. Its implementation assumes no HTTP particulars (like specific header formats).

Still, you must understand a number of concepts from HTTP's caching model in order to use this package effectively. Those are explained in ["Caching Model"](./docs/caching-model.md). Please read that, or many of the names and APIs in this package won't make sense.

### Backing stores

The `Cache` class can only function with a "backing store" that actually holds the cache's entries. There is a common `Store` interface (see the [types file](./src/types/06_Store.ts)) that all stores must implement. We currently have four backing stores: one that [holds items in memory](./src/stores/MemoryStore/MemoryStore.ts); one that [stores items in Postgres](./src/stores/PostgresStore/PostgresStore.ts); one that [uses Sqlite](./src/stores/SqliteStore/SqliteStore.ts); and one [backed by Redis](./src/stores/RedisStore/RedisStore.ts).

Note that not all backing stores will be able to store all kinds of data, although it's recommended that general-purpose stores be able to store any data that's JSON-serializable. Store implementations can communicate the type of data they support by adding a constraint on their first type parameter, e.g., a store with the signature `class MyStore<Spec extends CacheSpec<string, string[]>, ...>` is indicating that it can only store string arrays. Trying to use a store with a `Cache` instance parameterized for entries of different types will yield a type error.

### Per-id content typing (heterogeneous caches)

The `Cache` class is parameterized by a [`CacheSpec`](./src/types/00_CacheSpec.ts), which pairs each `id` type with the corresponding `content` type. In the simple case, all ids return the same kind of content, and `Spec` can stay as the default. To support multiple id-to-content mappings within a single cache, pass a _union_ of `CacheSpec`s; the cache's `get`/`store`/`getMany` methods then narrow the content type based on each request's id, and reject mismatched (id, content) pairs at compile time.

For example, a cache that holds both individual stories and collections of stories:

```ts
type StoriesCacheSpec =
  | CacheSpec<`story:${string}`, Story>
  | CacheSpec<`collection:${string}`, Story[]>;

const cache = new Cache<StoriesCacheSpec>(new MemoryStore());

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

#### Single-id-type vs. multi-id-type producers

`RequestPairedProducer` automatically takes one of two shapes depending on whether your `Spec` is a single `CacheSpec` or a union:

- **Single-id-type mode** (one `CacheSpec` variant — the most common case): the producer is a plain non-generic function `(req) => Promise<RequestPairedProducerResult<...>>`. There's only one possible content type, so per-id correlation is trivial.
- **Multi-id-type mode** (a union of `CacheSpec`s): the producer is generic over the request's specific id, so its return must match the spec variant that id selects. TypeScript can't narrow a free type parameter via runtime checks on `req.id`, so the recommended way to write a multi-id-type producer is via [`producerByIdType`](./src/utils/producerByIdType.ts):

```ts
const fetcher = wrapProducer<StoriesCacheSpec>(
  cache,
  options,
  producerByIdType<StoriesCacheSpec>()
    .when(idStartsWith("story:"), async (req) => ({
      // req.id: `story:${string}`  ⇒  TS requires `content: Story`
      content: { id: req.id, title: `Story ${req.id}` },
      directives: { freshUntilAge: 60 },
    }))
    .when(idStartsWith("collection:"), async (req) => ({
      // req.id: `collection:${string}`  ⇒  TS requires `content: Story[]`
      content: [{ id: "1", title: "a" }, { id: "2", title: "b" }],
      directives: { freshUntilAge: 60 },
    }))
    .build(),
);
```

Each `.when(...)` call infers its own narrowed id type from the supplied type guard, so each handler's `req.id` is concrete and the `(id, content)` correlation is fully checked per-branch.

## Key Files

- [`Cache.ts`](./src/Cache.ts): this defines the basic cache class. Note that the class's job is just to return whether/which previously-stored responses are usable to satisfy an incoming request. It does not handle things like making requests to the producer for new responses when no cached response is usable.

- [`MemoryStore.ts`](./src/stores/MemoryStore/MemoryStore.ts): a store for retaining cached data in memory, with a TTL and optional LRU eviction to cap memory usage.

- [`PostgresStore.ts`](./src/stores/PostgresStore/PostgresStore.ts): a store for retaining cached data in Postgres.

- [`RedisStore.ts`](./src/stores/RedisStore/RedisStore.ts): a store for retaining cached data in Redis. Takes an injected `ioredis` client (`Redis` or `Cluster`); the caller owns the client's lifecycle, TLS, and AUTH configuration. Variants for the same `id` are co-located on one Cluster shard via a `{<id>}` hashtag, so the store's `MGET`-based read path stays slot-local.

The package provides **five** functions for wrapping a producer with a cache. They split along two axes — single vs. bulk, and "lookup" vs. "compute":

- [`wrapProducer.ts`](./src/utils/wrapProducer.ts) — **`wrapProducer`**: the package's most important export, arguably. It takes a producer (i.e., a function that returns some data to cache) and a `Cache` instance, and it returns an equivalent function that will use a cached value when a suitable one is available, but otherwise call through to the underlying producer and store its return value for future requests.

- [`wrapBulkProducer.ts`](./src/utils/wrapBulkProducer.ts) — **`wrapBulkProducer`**: the same idea for a producer that resolves many requests at once. It looks each request up in the cache and calls the underlying producer only for the ones that missed (or need background revalidation).

  `wrapProducer` and `wrapBulkProducer` both treat the cache **`id` as a reference to a mutable entity**: the caller already has the id, and the cached value is whatever that entity currently is — a function of the `id` and time (e.g. "the current `User` for `user:123`"). The id is the natural cache key, so the producer receives it directly.

- [`wrapComputingProducer.ts`](./src/utils/wrapComputingProducer.ts) — **`wrapComputingProducer`** and **`wrapBulkComputingProducer`**: the "compute" counterparts to the two above, for when the cached value is not an entity looked up by id but an expensive-to-compute **function of some input** — value = `f(input)`, reused whenever the same input recurs (e.g. an LLM extraction over a chunk of text). Here a hash of the input is the natural cache key, but the producer wants the original, un-hashed input to do the work. You pass a single options object (the `cache` lives in it too) with a `hashInput` function (which may return any `string` subtype — e.g. `` `extract:${string}` `` — so the resulting spec composes safely with others), plus a producer that takes the full input; the wrapper derives the cache id from the hash, keeps the input around (reference-counted, so it survives request collapsing without leaking) just long enough to hand it to the producer on a miss, and otherwise behaves like `wrapProducer`/`wrapBulkProducer`. A computing producer may also return `supplementalResources`, but keyed by the **input** they'd be computed from (not a bare id) — the wrapper hashes those inputs, so a later `compute(thatInput)` is a hit.

- Also in [`wrapComputingProducer.ts`](./src/utils/wrapComputingProducer.ts) — **`computingProducerByInputType`**: the computing analog of `producerByIdType`, for a *heterogeneous* computing cache. You declare a union of `ComputingVariant<Input, Content>` and add a branch per variant with `.when(guard, produce)`; because each branch's `produce` is authored against a single, narrowed input, the types enforce that it returns that variant's content and that any cross-type `supplementalResources` pair a variant's input with that variant's content (so "computing a collection also caches its individual items" is checked end to end). `.build()` returns an ordinary computing producer to hand to `wrapComputingProducer`. See the file's module doc for more on the "lookup vs. compute" distinction.

## Running the tests

Most of the suite runs without any infrastructure. The `PostgresStore` and `RedisStore` conformance suites need real Postgres and Redis instances respectively; they're skipped automatically when their environment variables (`DATABASE_HOST`/etc. for Postgres, `REDIS_URL` for Redis) aren't set.

For local development, a `docker-compose.yml` is provided that brings up both. The included `test:docker` script starts the services, points the tests at them, and runs the full suite:

```bash
pnpm run test:docker        # starts services + runs tests with env wired up
pnpm run test:docker:down   # stops the services when you're done
```

The defaults bind to non-default host ports (Redis 6380, Postgres 5433) to avoid colliding with locally-running Redis/Postgres instances. Override via `REDIS_PORT` / `DATABASE_PORT` / `DATABASE_USER` / `DATABASE_PASSWORD` / `DATABASE_NAME` if you want different settings.
