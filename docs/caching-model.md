# Caching Model

## Concepts from HTTP

There are a few important concepts and terms to understand in order to use this library effectively:

### Consumer and Producer Directives

In most caching models, one party (the "producer") inserts a value into the cache and gives the cache some minimal instructions — usually just a TTL indicating how long the cache should hold the value. Then, the reader (aka, the "consumer") comes and asks for the value, which is served from the cache directly, or, if the TTL has passed, is returned after the cache goes back to the producer and gets a new, possibly-changed value.

In contrast to the caching model above, **HTTP's model allows _both_ the producer and the consumer to provide instructions to the cache** about whether a cached value is acceptable. These are called "directives".

For example, the consumer can say: "I only want a cached value if the value is less than 10 seconds old". In this way, even if the producer indicated that the value is likely to still be up to date for 30 seconds, the consumer can indicate that it has higher accuracy requirements (and is presumably willing to get some extra latency).

Meanwhile, the producer can provide instructions beyond just a TTL. For example, the producer can say "if the cache is unable to reach the producer to refresh the value, it can use the value for 10 extra seconds beyond what you normally be allowed"; by providing this directive, the consumer gets higher availability at the expense of a bit older data.

### Ages and Cache Chains

**Every cached value has an "age"** in HTTP, which is the amount of time that's passed since the value was generated -- or since the cache has confirmed with the producer that the value held in the cache still reflects the latest value.

An age is **subtly different from a TTL**, and this difference becomes apparent when you consider that **caches can be chained transparently in HTTP**. That is, a cache can pull data from (i.e., treat as the origin) a producer that _is itself a cache_. This chaining is a key to HTTP's scalability.

To make it work, though, producers must provide the age of each value that they return, at the time they return it. This age will, of course, be 0 if the producer is the original source of the value; but it can be non-zero if the producer is another cache (because the value will have aged while that cache was storing it).

Then, each cache can sum the age it received from the producer with the amount of time it's been storing the value to calculate the true, current age at any moment in time. When a request comes in, it will use this age to apply the consumer/producer directives, and will also pass the age on in its response, to enable more chaining.

In a system where values are cached with a decreasing TTL (rather than an increasing age), a chain of caches would still be possible — each cache would simply store the value in the subsequent cache with a TTL that subtracts the amount of time it's held the value from the TTL it received when storing the value — but a cache at the end of the chain would have no way to know how long ago the value its receiving was actually generated, making it impossible to respond accurately to consumer directives like "I only want a cached value if it's less than 5 seconds old".

### Fresh and Stale Values

**Cached values are either fresh or stale.** A fresh value is one whose age is less than a producer-provided "freshness lifetime". In choosing the freshness lifetime, the producer is saying that values younger than that amount of time _probably_ haven't changed, and are therefore safe to use.

By default, a fresh value can be returned by the cache without contacting the origin/underlying producer to verify that its up to date. Fresh values are what you typically think of in terms of returning a value "from cache".

Meanwhile, any value that's not fresh is said to be stale.

The concept here is standard, but the "fresh"/"stale" terminology is used in many of this package's APIs, so it's good to know.

### Validation

Imagine the consumer says, along with its request, that it has a cached value from date x. The producer may be able to do something very fast — say, read a `last_modified` column or a check file's modified date — to figure out whether the value changed between date x and now. If it hasn't, the producer can just reply "your cached value is still good", rather than having to send a lot of data or do an expensive computation to figure out the current value. Then, the consumer can use its stored response and reset its age to 0.

This idea is called "validation" in HTTP, and it can be a huge performance win. HTTP implements validation through various headers (`Last-Modified`, `Etag`, `If-Modified-Since`), and the concept of "conditional requests" with the `304` status code.

However, the details of HTTP's implementation don't matter, and this package doesn't borrow them; instead, the key point is the underlying peformance insight: It can be much faster/cheaper for a producer to verify that a cached value the consumer has seen is still up-to-date than it would be for the producer to generate and send the current value again.

### Retaining Stale Responses

An interesting consequence of supporting validation is that responses previously stored in the cache can still be useful — even if they're too old to actually return to consumers without first "revalidating" them.

For example, if a producer said its response is only fresh for 10 seconds, then you'd intuitively think that, after 10 seconds, a cache that's been storing this response will delete it to reclaim storage space, since it's too old to use to satisfy a consumer's request anyway.

Once validation is in play, though, that's no longer a safe assumption: even hours later, the value may be the same at the origin; so, for the producer to be able to tell the cache, in response to a validation request, "just use the value you got earlier", the cache must still be retaining that old value!

Beyond that, HTTP supports a directive that allows consumers to request arbitrarily old responses, even if they're stale. (This allows the consumer to decide that it cares more about speed than data accuracy.)

Between these two things, a stored response is never definitively useless to hold on to, even if it's ancient. Accordingly, caches are never required to delete stored responses. [Although there is a directive for producers and consumers to indicate that they don't want caches to store a given request/response at all, for privacy reasons.]

Instead, caches are just supposed to come up with their own strategies for managing their limited storage space — maybe removing the least-recently used items, or the ones that are oldest, or whatever.

This package offers producers and consumers a bit more control over how long their data can be stored (see below) but, in the default case where the parties don't explicitly specify storage time limits, this package generally takes the same approach as HTTP — leaving it up to the store what to evict and when — because, again, validation demands that.

## Dynamic, producer-determined cache keys

In HTTP, the cache key for a response by default is its URI and associated request method. In other words, two requests for `GET /x` can generally be served the same cached response _even if those requests were made with different headers!_ The assumption is that the headers between requests almost never match perfectly — think about `User-Agent` and `Accept` — so requiring them to be identical [i.e., making them part of the cache key] would drive cache hit rates to near 0.

However, when a header _does_ change the server's response, the server can indicate that, by using a `Vary` header in its response that lists the headers that the response depended (varied) on.

This has the interesting consequence that it's impossible to know ahead of time what information in the request will end up being part of the response's cache key! Relatedly, the server can return a different `Vary` value on different responses, so different request headers can actually be part of the cache key for different responses.

I'm not sure if HTTP's design (using dynamic cache keys in this manner) would be considered a good idea, if judged in a vacuum. Nevertheless, the cache in this package implements a similar model so that it can be used to faithfully implement an HTTP cache (except for subtle differences in directive semantics; see below). If you don't want to have dynamic cache keys in this manner, your producers should simply always indicate that their values don't vary on any request parameters.

In particular, in this pacakge's implementation, there's field called `id` that serves as the primary cache key, but consumers may also provide "parameters" [separate from cache directives] when asking for values, and the producer can indicate that its result depended on certain parameters being present with certain values (through `ProducerResultResource.vary`).

## Differences from the HTTP Model

### Different Directives

The particular set of directives that HTTP supports is not particularly elegant. Some directives are only usable by one party (producer or consumer), even though the other party could likely benefit from having access to those directives as well. Moreover, in some cases a directive available to one party is just a less general version of a directive available to the other party.

For example, consumers can use a `max-stale=n` directive to indicate that they're willing to accept responses that have been stale for up to `n` seconds. And producers can use a `must-revalidate` directive to require that the cache never serve stale values (overriding the `max-stale`, if any). This creates an asymmetry — `max-stale` for consumers and `must-revalidate` for producers — while also offering strictly less power than simply letting producers use `max-stale`. That is, a producer could use `max-stale` to say "the consumer may request stale values, but only up to some maximum level of staleness". Then, producers would just specify `max-stale=0` instead of needing `must-revalidate`.

As another example: a producer providing `max-age=0,must-revalidate` triggers incredibly similar behavior to the producer providing the `no-cache` directive, making it questionable whether the `no-cache` directive should exist.

My sense is that the set of HTTP directives is haphazard just because it evolved in an organic and perhaps decentralized way. So, this package takes the opportunity to introduce a slightly more rational set of directives — but that can stil express almost all of the semantics in HTTP's directives, so that this package can be the foundation for an HTTP cache.

### Directive Interactions

As part of the HTTP's directives being haphazardly defined, there are a number of cases where the interactions between directives are unspecified. In some of those cases, it seems clear what the interaction should be, as other readings would lead to clearly problematic/unintended behavior, or because one directive seems to be specified in stronger normative language than the other (suggesting that is meaning should be the controlling one). Still, there is no general framewrok for directive interaction, and I believe some interactions are genuinely ambiguous or produce undesirable semantics.

As a small example, consider the case where the producer's response contains the `no-cache` directive, which means that the cache _must_ validate its stored response with the origin on every request (even if the stored response is still fresh). The idea with this directive is to have the cache offer consumer's the performance benefits that can come with validation being cheaper than generating new responses, while not introducing any possibility for inconsistent data — since every response is checked with the origin. Now, imagine the producer combines this with a `stale-if-error` directive, which is explicitly intended to allow the cache to serve otherwise unusable responses in the case that it can't reach the origin. So, if a consumer request comes in and the origin is unavailable, should the cache use a stale response, or should it return an error?

In this case, the specs are actually quite clear: the `no-cache` directive should win, as the spec text for that directive says it "MUST" be followed, whereas the spec for `stale-if-error` uses "MAY" as its normative language. The problem with this reading is that the only reason a producer would provide `no-cache` and `stale-if-error` together is if the intention was for the `stale-if-error` directive to create an exception to the behavior otherwise required by `no-cache`! Having `no-cache` win, then, makes it impossible for the producer to say that a cache must always serve validated values except in the case that the origin is down, which could be useful. [The exact same issue applies to producers combining `must-revalidate` and `stale-if-error`.]

Unclear or unfortunate interaction rules like this abound in HTTP; this package instead uses one simple rule: every directive from both the consumer and the producer must be independently satisfied. I.e., whether a cached response is usable depends on whether directive A AND directive B and directive C apply. HTTP often seems to assuming this "AND" rule as well, but there are exceptions, and its directives don't always seem to be defined with this "AND" rule in mind (as in the `no-cache` example above).

## Directive definitions.

Per the above, the directives defined in this package are documented in the [types files](../src/types/index.ts).
