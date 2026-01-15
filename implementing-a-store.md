# Guidelines for Authoring a Store

When authoring a new store, there are a few concepts you'll need to know; a standard set of assumptions that you'll usually want to use when making implementation tradeoffs; and a few built-in utility functions that can simplify the process.

## Terminology/Concepts

- a "resource" is a stable entity identified by its `id`, analogous to a resource in HTTP.

- a variant refers to a particular `(id, vary)` tuple associated with a result from the producer. For example, imagine a producer result where the `id` is `cookies-recipe` and the `vary` value is `{ language: 'en-US' }`. This would be a distinct variant from ``(`cookies-recipe`, { language: 'es' })``. For more discussion on `vary`, see ["Dynamic, producer-determined cache keys"](./caching-model.md#dynamic-producer-determined-cache-keys) in the caching model docs.

- an "entry" is the representation of a variant received from the producer at some point. These entries are fundamentally what the cache is storing. In the example above, the entry would actually contain the content of the cookies recipe in one language.

## Common assumptions/Access Patterns

When making performance/implementation tradeoffs, consider that the following assumptions _generally_ hold true:

1.  Reading an entry from the store will be, by far, the most common and important operation. It will happen much more frequently than storing or invalidating an entry: if new entries were stored as often as they were read, caching would make no sense! So, you should optimize for making `myStore.get()` fast, even if that complicates or slows down `store()` and `delete()`.

2.  The most complicated part of the `get()` method is narrowing the stored entries to those whose variant matches the incoming request's parameters. The fundamental complexity here stems from the fact that a request with `n` parameters could hypothetically match `2^n` variants — e.g., a request with parameters `{ a: true, b: false }` would match stored entries with `vary` values of `{}`, `{ a: true }`, `{ b: false }`, or `{ a: true, b: false }`. When handling this complexity, consider:
    - Many/most resources will have only one variant — a variant that varies on no params, called the "empty vary variant". This assumption is based on the observation that multiple variants per resource has always been a bit niche/rarely used, even in HTTP where there's truly first-class support for it. Therefore, you may want to consider implementing a fast-path for lookups of resources with only this one variant.

    - Even for resources that do have multiple variants, the number of parameters the resource varies on may be much smaller than the number of parameters on incoming requests. This is certainly true in the HTTP context, where there might easily be a dozen request headers but the resource might only vary on one or two (say, `Accept` and `Accept-Language`). In that scenario, a request with 12 headers could match 4096 variants, but, because the resource in fact only varies on 2 headers, only 4 of those 4096 variants could actually exist. This generally makes it infeasible for `Store` implementations to query for all variants that could match based on solely the incoming request's parameters.

    - Moreover, for resources that do have multiple variants, those variants will probably all vary on the same set of parameters names. E.g., a `cookies-recipe` resource might vary on the request's `language` and `imageResolution` parameters — but it'd be very weird if _some_ results from the producer depended on the those request parameters while others didn't. Therefore, every call to `myStore.get()` will usually match entries for only one variant! E.g., if the call is

      ```ts
      store.get("cookies-recipe", {
        language: "something",
        imageResolution: "max",
        /* ... 10 other parameters here ... */
      });
      ```

      there are again 4096 hypotethical variants this call could match but, in reality, it'll only match entries with exactly `{ language: 'something', imageResoluton: 'max' }` as their `vary` value.

      To exploit this, it's generally a good idea to track all the sets of request parameter names that a given resource has been seen to vary on, and use that to efficiently determine exactly which variants to query for (based on the values of those parameters in the request). Note that this is a set of sets, because it can happen that different entries
      for the same resource vary on different parameters — although the reason for this is often a bug in the producer ([e.g. here](https://www.rfc-editor.org/rfc/rfc9111#section-4.1-7)). Usually, though, this will only contain one set in it. In the example above, it'd be `{ {language, imageResolution} }`.

    - The number of variants for a resource can be unboundedly-large. This happens especially for resources that have one variant _per user_ (i.e., vary on a param like `user-id` or, in the HTTP context, `Authorization` or `Cookie`). Therefore, assuming the entries are stored in some backing database, it's generally not safe to simply load all the entries for a given resource into JS memory and filter them there. (However, a Store could do this if it put some limit on how many entries it would load per resource in a `get()` call -- at the expense of artificially lowering the hit rate in these sorts of cases by not returning all matching entries.)

## Useful helper functions

- All the [`vary`-related helper functions](../src/utils/varyHelpers.ts)
