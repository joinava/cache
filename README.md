# cache

## Package Contents

This package provides a class, [`Cache`](./src/Cache.ts), that implements caching using a model inspired by [HTTP's](https://datatracker.ietf.org/doc/html/rfc9111). The HTTP model is already incredibly powerful, and this class generalizes and extends it further in some ways.

Even though this package borrows ideas from HTTP, it can be used to cache any kind of data from any source, not just HTTP responses. Its implementation assumes no HTTP particulars (like specific header formats).

Still, you must understand a number of concepts from HTTP's caching model in order to use this package effectively. Those are explained in ["Caching Model"](./docs/caching-model.md). Please read that, or many of the names and APIs in this package won't make sense.

### Backing stores

The `Cache` class can only function with a "backing store" that actually holds the cache's entries. There is a common `Store` interface (see the [types file](./src/types/06_Store.ts)) that all stores must implement. We currently have two backing stores, one that [holds items in memory](./src/stores/MemoryStore.ts) and one that [stores items in Postgres](./src/stores/PostgresStore/PostgresStore.ts).

Note that not all backing stores will be able to store all kinds of data, although it's recommended that general-purpose stores be able to store any data that's JSON-serializable. Store implementations can communicate the type of data they support by adding a constraint on their first type parameter, e.g., a store with the signature `class MyStore<T extends string[], ...>` is indicating that it can only store string arrays. Trying to use a store with a `Cache` instance parameterized for entries of different types will yield a type error.

## Key Files

- [`Cache.ts`](./src/Cache.ts): this defines the basic cache class. Note that the class's job is just to return whether/which previously-stored responses are usable to satisfy an incoming request. It does not handle things like making requests to the producer for new responses when no cached response is usable.

- [`MemoryStore.ts`](./src/stores/MemoryStore/MemoryStore.ts): a store for retaining cached data in memory, with a TTL and optional LRU eviction to cap memory usage.

- [`PostgresStore.ts`](./src/stores/PostgresStore/PostgresStore.ts): a store for retaining cached data in Redis.

- [`wrapProducer.ts`](./src/utils/wrapProducer.ts): this is the package's most important export, arguably. It takes a producer (i.e., a function that returns some data to cache) and a `Cache` instance, and it returns an equivalent function that will used a cached value when a suitable one is available, but otherwise call through to the underlying producer and store its return value for future requests.
