# @zingage/cache 2.0: resource-type registry, derived Spec, redesigned diagnostics

Status: DRAFT for review. Backwards compatibility is explicitly **not** a constraint
(one known consumer: the Zingage monorepo; migration plan in §9).

## 1. Problem

Three defects in the current contract, all downstream of one modeling gap — the
package has no runtime concept of *what kind of resource an id refers to*:

1. **`cacheName` names the wrong thing.** It's an option on
   `wrapProducer`/`wrapBulkProducer`, so it names a *wrapped producer flow*. What
   consumers actually want named in telemetry is (a) the cache instance (≈ the
   backing table) and (b) the resource type of the entry/request. Flow naming is
   simultaneously too fine (well-sky creates two wrapped producers over one cache
   just to get two names) and too coarse (axis-care's one `producerByIdType`
   producer spans two resource types under a single name, so site-day refreshes
   and business-slice reads are indistinguishable in Datadog).

2. **The store layer has no identity at all.** `Cache.store()` publishes
   store-entry-result events (added in 1.6.0) with no way to say which cache or
   which kind of entry they describe. Threading the wrapper's `cacheName` through
   `store()` was considered and rejected: it would *mis*attribute supplemental
   resources (a `business_slice` entry written by the `site_day` producer would
   carry the site flow's name) and can't attribute direct `Cache.store()` callers
   at all.

3. **The read channel's `outcome` conflates two questions.** `hit`/`miss`/
   `stale_while_revalidate` describe *what the cache lookup found*;
   `uncacheable`/`bypass` describe *why the cache wasn't consulted*. And several
   dispositions are invisible entirely: producer errors, stale-if-error serves,
   aborts, producer latency. Lookups made via direct `Cache.get()` (e.g. the
   monorepo's knowledge rule-run cache) emit nothing today because the only
   telemetry lives in the wrappers.

The modeling insight (from design discussion, 2026-07-28): **a cache admits at
most one producer per disjoint id-partition** ("resource type"). Two producers
with overlapping id spaces would be two sources of truth for the same key —
racing collapses, last-writer-wins churn, spurious `changed` events from 1.6.0's
change detection. Every real usage respects this (the closest exception,
axis-care service-definitions' dual writer, partitions *fields* of one entry and
needed hand-written merge logic to coexist — the model straining, not a
counterexample). Since resource types are 1:1 with names and with `CacheSpec`
branches, the registry of named, classifiable resource types belongs on the
**Cache**, and everything else — producer dispatch, coverage inference,
telemetry attribution — falls out of it.

## 2. Success criteria

- Every diagnostics message carries `{ cache, resourceType }`; a Datadog
  subscriber can build per-cache, per-resource-type hit-rate, producer error/
  latency, and changed/unchanged panels with no name threading anywhere.
- Supplemental writes and direct `Cache.store()`/`Cache.get()` calls are
  attributed correctly (the case flow-name threading could never solve).
- `producerByIdType` and its `.when()` builder are deleted; producers are
  declared per named resource type, and each wrapper's coverage — any
  non-empty subset of the registry, inferred from its record keys — bounds
  the wrapped function's request type.
- An id that classifies to no resource type (or more than one) is a **loud
  runtime error** on both get and store — the "orphaned supplemental write"
  class of bug (see the monorepo's `site-visit-slices.test.ts` id-round-trip
  guard) becomes unrepresentable at runtime instead of test convention.
- Producer failures, stale-if-error serves, and producer durations become
  observable (they are invisible today).
- Zero changes required to `Store` implementations.

## 3. Scope

**In (package version 2.0.0):**

- Resource-type registry on `Cache` (`name` + `resourceTypes`, both required),
  `SpecOf` derivation, `classify()`.
- `wrapProducer` / `wrapBulkProducer` take per-resource-type producer maps;
  `producerByIdType` / `computingProducerByInputType` and their builders are
  removed.
- Hashed-input producers take per-covered-type `{ matchesInput, hashInput,
  produce }` branches.
- Channel redesign: `read`, `fetch`, `produce`, `store-entry` (all messages
  carry cache + resource type). The 1.6.0 `dropped-directive` channel is
  deleted outright, with no successor (§6.5.5) — the directive-dropping
  behavior itself is unchanged.

**Out:**

- Promoting `contentHashValidator` into the package. It stays app-side in the
  monorepo (`canonical-json-digest.ts`, PR #11177); the package consumes
  whatever validators producers attach and ships no validator factory.
- Conditional revalidation (using `validatable` entries + validators to issue
  If-None-Match-style producer calls) — the `read` message reserves a field.
- Store-level schema validation per resource type (registry is shaped so a
  `content` codec/schema can be added later without another breaking change).
- Any change to store implementations, the vary/params model, directives, or
  normalization.

## 4. Evidence

- Monorepo PR #11177: all ~42 producer sites + ~8 direct-store sites now attach
  `contentHash` validators; the store-entry Datadog metric shipped **without a
  cache tag** because the message can't carry one — the immediate motivator.
- `apps/backend/.../well-sky/core/site-persons.ts`: two `wrapProducer` calls
  over one cache purely to get two names (`well_sky_site_clients`,
  `well_sky_site_caregivers`).
- `apps/backend/.../axis-care/integration.ts` `#getAllVisitsCached`: one
  `producerByIdType` producer spanning `SiteVisitsKey` and
  `SiteBusinessVisitsKey` under the single name `axis_care_site_visits`.
- `apps/backend/.../knowledge/.../rule-run-cache.ts`: direct `Cache.get()`
  reads that emit no telemetry today.
- `site-visit-slices.test.ts` ("a drift here silently orphans every
  supplemental entry"): the orphaned-write hazard classification-on-store
  eliminates.

## 5. Ownership boundary

- **This package owns:** the registry contract, classification, all channel
  names/message shapes, and producer dispatch.
- **Stores own (unchanged):** persistence, vary matching, in-call dedup,
  change detection (`StoreEntryRelationship`).
- **Applications own:** registry definitions per cache, subscribing channels to
  their metrics backend, choosing metric/tag names, and producing validator
  values (e.g. the monorepo's app-side `contentHashValidator`).

---

## 6. Key contracts — the full 2.0 surface

Everything below is the complete public contract. §6.6 lists what is exported
unchanged from 1.6.0. Notation: signatures are written as they will appear in
`.d.ts` (imports elided).

### 6.1 Resource types and the registry

```ts
// src/types/00_CacheSpec.ts — CacheSpec, SpecForId, ContentForId are UNCHANGED.
export type CacheSpec<out Id extends string = string, out Content = unknown> = {
  readonly id: Id;
  readonly content: Content;
};

// src/types/00_ResourceTypes.ts (new)

declare const contentType: unique symbol;

/**
 * One named kind of resource a cache can hold: a total classifier for its id
 * sub-space, plus a phantom carrier for the content type (no runtime value).
 * Construct with `resourceType<Content>()({ matches })` so `Content` can be
 * supplied explicitly while `Id` is inferred from the guard.
 */
export type ResourceTypeSpec<Id extends string = string, out Content = unknown> = {
  readonly matches: (id: string) => id is Id;
  readonly [contentType]?: Content; // phantom
};

/** Curried so Content is explicit and Id is inferred from `matches`. */
export function resourceType<Content>(): <Id extends string>(def: {
  matches: (id: string) => id is Id;
}) => ResourceTypeSpec<Id, Content>;

/**
 * Sugar for single-type caches: matches every id. A cache whose registry has
 * exactly one entry may use this instead of writing a trivial guard.
 *
 * `Id` (default `string`) narrows the type's id space at the TYPE level:
 * template-literal ids (e.g. `` `zendesk-ticket-schema:${string}` ``) and
 * branded ids (e.g. `JsonOf<SiteVisitsKey>`) flow through `SpecOf` into the
 * wrapped function's request type, the producer's `req.id`, `hashInput`'s
 * required return type (§6.4), and `Entry` types. The runtime guard remains
 * trivially true, so classification never fails on a sole-type cache
 * (matching 1.6.0, which had no classification for single-spec caches):
 * a malformed id is rejected by the compiler at call sites, not at runtime —
 * indeed for branded ids no inspecting guard is even writable. When runtime
 * enforcement is wanted too, don't use this sugar; write the one-entry
 * registry with a real guard (`resourceType<Content>()({ matches:
 * idStartsWith("…") })`), which is fully legal and throws
 * `UnclassifiableIdError` on nonconforming ids.
 */
// SUPERSEDED by 6.8: the `Id` parameter was unsound (an asserted narrowing
// behind an accept-everything guard) and was removed. Shipped signature:
//   export function soleResourceType<Content>(): ResourceTypeSpec<string, Content>;
export function soleResourceType<
  Content,
  Id extends string = string,
>(): ResourceTypeSpec<Id, Content>;

/** A cache's registry: resource-type name → spec. */
export type ResourceTypes = { readonly [name: string]: ResourceTypeSpec };

export type ResourceTypeName<RT extends ResourceTypes> = keyof RT & string;

export type IdOfResourceType<T extends ResourceTypeSpec> =
  T extends ResourceTypeSpec<infer Id, unknown> ? Id : never;

export type ContentOfResourceType<T extends ResourceTypeSpec> =
  T extends ResourceTypeSpec<string, infer Content> ? Content : never;

/**
 * THE derivation that removes the parallel-declaration drift: the cache's
 * `Spec` union is computed from the registry rather than declared beside it.
 */
export type SpecOf<RT extends ResourceTypes> = {
  [K in ResourceTypeName<RT>]: CacheSpec<
    IdOfResourceType<RT[K]>,
    ContentOfResourceType<RT[K]>
  >;
}[ResourceTypeName<RT>];
```

```ts
// src/utils/producerByIdType.ts → the classifier helper SURVIVES; the builder dies.
export function idStartsWith<Prefix extends string>(
  prefix: Prefix,
): (id: string) => id is `${Prefix}${string}`;
```

**Classification contract.** `matches` guards must partition the id space:
for every id the cache will ever see (requests, primary results, supplemental
results, deletes), **exactly one** registry entry must match. Classification
evaluates every guard; zero matches throws `UnclassifiableIdError`, two or more
throws `AmbiguousResourceTypeError` (fail loud over first-match-wins, so an
overlap is caught the first time it occurs rather than silently resolved by
object-key order). A guard that **throws** is treated as not matching — guards
routinely reject foreign ids by failing to parse them (the `jsonParse` idiom
below throws on any non-JSON id), so a throw is a "no"; when no type then
matches, the guard error(s) surface as the `UnclassifiableIdError`'s `cause`
(an `AggregateError` when several threw) rather than leaking as a raw parse
error with no cache/id attribution. Guards should be cheap (prefix checks preferred); ids must
therefore carry their type in-band. This is already the package idiom
(`idStartsWith`, and hashed hashed-input ids like
`zendesk-ticket-schema:${businessId}:${hash}`), but 2.0 makes it a stated
requirement: **an id must be classifiable by inspection.**

Authoring pattern (registry first, everything derived):

```ts
const siteVisitsResourceTypes = {
  site_day: resourceType<AxisCareVisit[]>()({
    matches: (id): id is JsonOf<SiteVisitsKey> => !("businessId" in jsonParse(id)),
  }),
  business_slice: resourceType<AxisCareVisit[]>()({
    matches: (id): id is JsonOf<SiteBusinessVisitsKey> => "businessId" in jsonParse(id),
  }),
} satisfies ResourceTypes;

type SiteVisitsSpec = SpecOf<typeof siteVisitsResourceTypes>;
// = CacheSpec<JsonOf<SiteVisitsKey>, AxisCareVisit[]>
// | CacheSpec<JsonOf<SiteBusinessVisitsKey>, AxisCareVisit[]>
```

### 6.2 Cache

```ts
// src/Cache.ts

export type CacheLookupResult<           // UNCHANGED shape
  MatchingSpecs extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = {
  usable?: Entry<MatchingSpecs, Validators, Params> | undefined;
  usableWhileRevalidate?: Entry<MatchingSpecs, Validators, Params> | undefined;
  usableIfError?: Entry<MatchingSpecs, Validators, Params> | undefined;
  validatable: Entry<MatchingSpecs, Validators, Params>[];
};

export default class Cache<
  const RT extends ResourceTypes = ResourceTypes,   // ← was: Spec extends CacheSpec
  Validators extends AnyValidators = AnyValidators,
  in out Params extends AnyParams = AnyParams,
> {
  // SUPERSEDED by 6.8: one options bag, with the store inside it. Shipped
  // signature: `constructor(options: CacheOptions<RT, Validators, Params>)`.
  constructor(
    dataStore: Store<SpecOf<RT>, Validators, InvariantOf<Params>>,
    options: {
      /**
       * REQUIRED. Names this cache instance (≈ the backing table) in every
       * diagnostics message. Instance-unique per process by convention;
       * uniqueness is not enforced.
       */
      name: string;
      /** REQUIRED. See §6.1. Must partition the id space. */
      resourceTypes: RT;
      logger?: Logger;
      onGetAfterClose?: "throw" | "act-empty";
      onStoreAfterClose?: "throw" | "no-op";
      normalizeParamName?: NormalizeParamName<Params>;
      normalizeParamValue?: NormalizeParamValue<Params>;
    },
  );

  readonly name: string;

  /**
   * The registry (constructor `options.resourceTypes`), exposed so the
   * wrapper generics can infer `RT` through `PublicInterface<Cache<…>>` —
   * there is no other inference site (`SpecOf<RT>` isn't invertible), and
   * without it a narrowed sole-type cache collapses producer ids to `string`.
   */
  readonly resourceTypes: RT;

  /**
   * Total classification. Throws UnclassifiableIdError (0 matches) or
   * AmbiguousResourceTypeError (>1 match). Runs on every get/getMany request
   * id, every stored entry id (primary and supplemental), and every delete id
   * — classification failures reject the operation BEFORE touching the store.
   */
  classify(id: string): ResourceTypeName<RT>;

  get<Id extends SpecOf<RT>["id"]>(
    req: ReadonlyDeep<ConsumerRequest<Params, Id>>,
    options?: { signal?: AbortSignal },
  ): Promise<CacheLookupResult<SpecForId<SpecOf<RT>, Id>, Validators, Params>>;
  // Emits one `read` message (§6.5.1).

  getMany<
    const Reqs extends readonly ReadonlyDeep<ConsumerRequest<Params, SpecOf<RT>["id"]>>[],
  >(
    reqs: Reqs,
    options?: { signal?: AbortSignal },
  ): Promise<{
    -readonly [K in keyof Reqs]: CacheLookupResult<
      SpecForId<SpecOf<RT>, Reqs[K]["id"]>, Validators, Params
    >;
  }>;
  // Emits one `read` message PER request.

  store(
    data: readonly ProducerResultResource<SpecOf<RT>, Validators, Params>[],
  ): Promise<readonly StoreEntryResult[]>;
  // Emits one `store-entry` message PER entry (§6.5.4). Classification of all
  // entry ids happens up front; any failure rejects before persisting anything.

  delete(id: SpecOf<RT>["id"]): Promise<void>;

  close(timeout?: number): Promise<void>;

  readonly emitter: EventEmitter;               // UNCHANGED ("store" event)
  readonly normalizeParamName: NormalizeParamName<Params>;
  readonly normalizeParamValue: NormalizeParamValue<Params>;
}
```

Errors (all carry enough to debug from a log line):

```ts
export class UnclassifiableIdError extends Error {
  readonly name = "UnclassifiableIdError";
  readonly cacheName: string;
  readonly id: string;
  // + standard `cause` when the miss came from throwing guard(s) (§6.1's
  // classification contract): the single guard error, or an AggregateError.
}

export class AmbiguousResourceTypeError extends Error {
  readonly name = "AmbiguousResourceTypeError";
  readonly cacheName: string;
  readonly id: string;
  readonly matchedResourceTypes: readonly string[];
}

/**
 * Thrown by the producer wrappers (not by Cache) when a request's id
 * classifies to a resource type outside the wrapper's inferred coverage
 * (§6.3). Reachable only via casts or loosely-typed ids — the wrapped
 * function's request type bans covered-set violations at compile time.
 */
export class NoProducerForResourceTypeError extends Error {
  readonly name = "NoProducerForResourceTypeError";
  readonly cacheName: string;
  readonly resourceType: string;
  readonly coveredResourceTypes: readonly string[];
  readonly id: string;
}
```

### 6.3 wrapProducer / wrapBulkProducer

`cacheName` is deleted. Producers are a per-resource-type record covering **any
non-empty subset** of the registry: the record keys are inferred as the
wrapper's coverage (`Covered`), which becomes the returned function's request
bound — replacing the `.when()` builder's `Covered`-tracking machinery and its
`_NonExhaustiveBuildError` tuple with plain key inference.

A wrapped function is a drop-in producer replacement — a *total* function over
its accepted ids — so it accepts exactly the covered types' ids; requests for
uncovered types are compile errors. A type with no producer in any wrapper is
legal and normal: its entries are written as other producers' supplemental
resources (or direct `store()` calls) and read via `Cache.get` — the
serve-if-present contract — which the `read` channel attributes like any other
lookup. Partial coverage is also what makes capability-scoped and split
wrappers honest: a second `wrapProducer` call can cover a different subset of
the same cache (well-sky site-persons keeps its two wrappers), and adding a
registry type grants no existing wrapper-holder fetch authority over it.
The trade-off, stated plainly: "who produces type X?" is answered by grep (or
the `produce` channel's `resourceType` tag), not by one lexical unit, and a
registry type nobody produces surfaces at the first consumer's compile error
rather than at a wrapper definition.

```ts
// src/utils/wrapProducer.ts

export type WrapProducerOptions<Params extends AnyParams> = {
  // `cacheName` and `isCacheable` REMOVED (see the purity contract below).
  // Everything else unchanged:
  onCacheReadFailure?: "throw" | "call-producer";
  collapseOverlappingRequestsTime?: number;
  logger?: Logger;
};

/** The producer for one resource type: sees only its own branch's ids. */
export type ResourceTypeProducer<
  RT extends ResourceTypes,
  K extends ResourceTypeName<RT>,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = (
  // No `options`/signal: see the 2026-07-30 note in §6.7.
  req: ReadonlyDeep<ConsumerRequest<Params, IdOfResourceType<RT[K]>>>,
) => Promise<
  RequestPairedProducerResult<SpecOf<RT>, Validators, Params, IdOfResourceType<RT[K]>>
>;
// Note: RequestPairedProducerResult already allows supplementalResources from
// ANY spec variant, so a site_day producer can still attach business_slice
// supplementals. UNCHANGED from 1.6.0.

/**
 * The producers this wrapper covers: one entry per covered resource type, any
 * non-empty subset of the registry. `Covered` is inferred from the record's
 * keys. (The 1.6.0-era "supplemental-only" sentinel is gone — non-coverage is
 * expressed by omission, so a wrapper never has to make claims about types
 * that other wrappers may produce.)
 */
export type ProducersFor<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = {
  readonly [K in Covered]: ResourceTypeProducer<RT, K, Validators, Params>;
};

/** What the wrapped function accepts (unchanged): params/directives optional. */
export type PartialConsumerRequest<Params extends AnyParams, Id extends string> = {
  id: Id;
  params?: Partial<Params>;
  directives?: ConsumerDirectives;
};

export default function wrapProducer<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
>(
  cache: PublicInterface<Cache<RT, Validators, Params>>,
  options: WrapProducerOptions<Params> | undefined,
  producers: ProducersFor<RT, Covered, Validators, Params>,
): <Id extends IdOfResourceType<RT[Covered]>>(
  req: PartialConsumerRequest<Params, Id>,
  options?: { signal?: AbortSignal },
) => Promise<EntryForId<SpecOf<RT>, Validators, Params, Id>>;
```

There is **no bare-function sugar** (1.6.0 accepted a lone producer): a bare
function can't carry a coverage key, and probing showed it structurally matches
the mapped record as `{}` — inferring `Covered = never` and yielding an
uncallable wrapper — so the sugar is unsound rather than merely omitted. Even
sole-type caches write `{ visits: producer }`: two extra tokens that put the
registry's type name at the wrap site. `wrapProducer` **throws at construction
time** if `producers` has no own enumerable keys (the empty record, or a bare
function passed by mistake — both compile-dead at call sites anyway, since no
id satisfies `Covered = never`).

Dispatch: the wrapper calls `cache.classify(req.id)` once per request and
invokes that type's producer. The classify result is also what stamps
`resourceType` on the `fetch`/`produce` messages, so dispatch and telemetry
cannot disagree. If the classified type is not in this wrapper's coverage —
reachable only via a cast or loosely-typed id, since the compiler bans typed
ones — the wrapper throws `NoProducerForResourceTypeError` **before reading
the cache**: serving a hit for an uncovered type would smuggle the
serve-if-present contract back in through a cast.

**Producer purity contract (new, explicit).** A producer passed to any wrapper
must be a side-effect-free read of its resource type's origin: every invocation
may be collapsed (shared with other concurrent logical callers) and its result
stored, so producer calls are never 1:1 with callers. 1.6.0's `isCacheable`
option — the escape hatch that skipped the read, the collapsing, *and* the
store for requests "made for their side effects" — is **deleted**. It was a
second, wrapper-level classifier of the request space (exactly the pattern this
redesign evicts), it has zero callers in the package's only consumer, and it
has no coherent home in the new model: its pass-through path skips both `get`
and `store`, so it would be the one lane where an unclassifiable id escapes
validation — while the `fetch` channel's `resourceType` attribution would
require classifying anyway. Each of its candidate jobs is already covered by an
existing primitive:

- a consumer that must reach the origin sends bypass directives (`maxAge: 0`);
- a producer whose response must not be stored returns `storeFor: 0` directives
  (the origin controls storage, as in HTTP);
- a request class that should never involve the cache is not a resource type of
  the cache, and shouldn't route through a wrapper at all (the HTTP analog —
  pass-through for unsafe methods — exists only because a proxy has a single
  entry point for all traffic; in-process, the type system is the router).

**Bypass requests skip the cache read (behavior change).** When
`isRequestingCacheBypass(directives)` (`maxAge: 0`), the wrappers no longer
call `Cache.get` at all: the read is provably useless absent conditional
revalidation — *except* for a hole this change closes. Age is a
millisecond-resolution float and the `maxAge` ceiling uses strict `>`
(`normalizedProducerResultResourceHelpers.ts`), so an entry stored in the same
millisecond (age 0) or written by a pod whose clock runs ahead (age *negative*
— birth date derives from the producer-stamped `date`) satisfies `maxAge: 0`
and would be served from cache against the consumer's evident intent. With
skip-read, `maxAge: 0` structurally guarantees producer contact, bypass
requests stop polluting the `read` channel with `found: "none"`, and the fetch
message's discriminated union (§6.5.2) becomes sound by construction. Bypass
requests still collapse (only with identical-directive peers — the collapse key
includes directives) and their results are still stored.

```ts
// src/utils/wrapBulkProducer.ts

/**
 * A bulk producer for ONE resource type. The wrapper groups collapsed
 * requests by classified resource type and issues one bulk call per type per
 * collapse window (a batch never mixes types — each type has its own origin).
 * Results are request-paired, same as 1.6.0; Error elements mark per-request
 * failures.
 */
export type BulkResourceTypeProducer<
  RT extends ResourceTypes,
  K extends ResourceTypeName<RT>,
  Validators extends AnyValidators,
  Params extends AnyParams,
  ErrorType extends Error,
> = (
  // No `options`/signal: see the 2026-07-30 note in §6.7.
  reqs: readonly ReadonlyDeep<ConsumerRequest<Params, IdOfResourceType<RT[K]>>>[],
) => Promise<
  (
    | RequestPairedProducerResult<SpecOf<RT>, Validators, Params, IdOfResourceType<RT[K]>>
    | ErrorType
  )[]
>;

export type BulkProducersFor<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators,
  Params extends AnyParams,
  ErrorType extends Error,
> = {
  readonly [K in Covered]: BulkResourceTypeProducer<RT, K, Validators, Params, ErrorType>;
};

export function wrapBulkProducer<
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  ErrorType extends Error = Error,
>(
  cache: PublicInterface<Cache<RT, Validators, Params>>,
  options: WrapProducerOptions<Params> | undefined,
  producers: BulkProducersFor<RT, Covered, Validators, Params, ErrorType>,
): <
  const Reqs extends readonly PartialConsumerRequest<
    Params,
    IdOfResourceType<RT[Covered]>
  >[],
>(
  reqs: Reqs,
  options?: { signal?: AbortSignal },
) => Promise<{
  -readonly [K in keyof Reqs]:
    | EntryForId<SpecOf<RT>, Validators, Params, Reqs[K]["id"]>
    | ErrorType;
}>;
// A reqs array may mix COVERED types (the wrapper partitions by classified
// type); ids of uncovered types are compile errors per element. Same
// construction-time keyless-record throw and pre-read
// NoProducerForResourceTypeError fallback as wrapProducer.
```

`producerByIdType`, `ProducerBranch`, `ProducerByIdTypeBuilder`, and the
non-exhaustive-build error type are **deleted**.

### 6.4 Hashed-input producers

> **Superseded (2026-07-30) by
> [2026-07-30-hashing-producer-builder.md](./2026-07-30-hashing-producer-builder.md).**
> The per-covered-type `branches` record described below shipped, then was
> replaced: the wrappers now take one options bag — `{ cache, hashInput, produce }`
> for a single resource type, or `{ cache, hashedInputProducer }` where the producer
> is built, cache-free, by `hashedInputProducerByInputType`. What follows still
> describes the coverage/minted-id/supplemental *contracts*, which carried over
> unchanged; the shape that carries them did not.

Initially: `computingProducerByInputType` and its builder/variant types
(`HashedInputVariant`, `HashedInputVariantSupplemental`, `InputForVariants`,
`ContentForVariants`, `ComputingProducerByInputTypeBuilder`) were **deleted** in
favor of a per-covered-type record (coverage inferred from the record's keys,
exactly as in §6.3 — any non-empty subset of the registry). Because hashed-input ids are hashes, the
in-band-discriminator requirement (§6.1) is on `hashInput`: each branch's
`hashInput` must mint ids that its resource type's `matches` guard accepts —
checked at runtime (the wrapper classifies the hashed id and throws
`UnclassifiableIdError`/`AmbiguousResourceTypeError` on mismatch, naming the
branch). For `soleResourceType` registries that runtime check is vacuous (the
guard accepts everything); there, `hashInput`'s compile-checked return type —
`IdOfResourceType`, i.e. the narrowed `Id` when the sole type declares one —
is the line of defense.

**Supplementals (restored to full 1.6.0 parity, 2026-07-29).** A computing
producer's `supplementalResources` accepts two forms, distinguished by which
key is present:

- **Input-keyed** (`{ input, content, … }`): identified by the input the
  value would be computed from. The wrapper routes each supplemental's input
  through the SAME `matchesInput` branch-selection it applies to call-time
  inputs, hashes it with the routed branch's `hashInput`, and mint-checks
  the result against that branch's type — so any COVERED branch (not just
  the producing one) can be the target, and a later `compute(thatInput)` is
  a hit. A mint-check failure rejects the invocation loudly, naming the
  branch (unlike store-time classification, which is fire-and-forget behind
  the wrappers).
- **Id-keyed** (`{ id, content, … }`, a plain `ProducerResultResource`): for
  ANY registry type, covered or not — exactly what plain producers'
  supplementals are. Classified by their own id at store time. This is what
  makes "hashed-input producers" (hashed-input wrappers used for key privacy —
  e.g. keeping a credential out of the cache key — rather than for pure
  computation) full peers of plain producers: fetch a site's data, hash the
  credential-bearing key, and still supplementally store per-business
  slices under their natural ids.

```ts
// src/utils/wrapHashedInputProducer.ts

export type HashedInputProducerResult<
  Input,
  Spec extends CacheSpec,              // the producing branch's spec (primary content)
  Validators extends AnyValidators,
  Params extends AnyParams,
  CoveredSpec extends CacheSpec = Spec,   // input-keyed supplemental targets (wrapper passes the covered union)
  RegistrySpec extends CacheSpec = Spec,  // id-keyed supplemental targets (wrapper passes the full registry union)
> = Omit<
  RequestPairedProducerResult<Spec, Validators, Params>,
  "id" | "supplementalResources"
> & {
  supplementalResources?: (
    | (CoveredSpec extends unknown
        ? Omit<ProducerResultResource<CoveredSpec, Validators, Params>, "id"> & { input: Input; id?: never }
        : never)
    | (RegistrySpec extends unknown
        ? ProducerResultResource<RegistrySpec, Validators, Params> & { input?: never }
        : never)
  )[];
};

export type ComputingBranch<
  Input,
  RT extends ResourceTypes,
  K extends ResourceTypeName<RT>,
  Validators extends AnyValidators,
  Params extends AnyParams,
  AllCovered extends ResourceTypeName<RT> = K,  // the wrapper's full coverage (for supplemental targets)
> = {
  /**
   * Input classifier for this branch. Required when the wrapper covers more
   * than one type; forbidden (and ignored) when it covers exactly one.
   */
  matchesInput?: (input: unknown) => input is Input;
  /** Must mint ids that this branch's `matches` guard accepts. */
  hashInput: (input: Input) => IdOfResourceType<RT[K]> | Promise<IdOfResourceType<RT[K]>>;
  produce: (
    // No `options`/signal: see the 2026-07-30 note in §6.7.
    input: ReadonlyDeep<Input>,
  ) => Promise<
    HashedInputProducerResult<
      Input,
      SpecForId<SpecOf<RT>, IdOfResourceType<RT[K]>>,
      Validators,
      Params,
      SpecForId<SpecOf<RT>, IdOfResourceType<RT[AllCovered]>>,  // input-keyed: any covered branch
      SpecOf<RT>                                                // id-keyed: any registry type
    >
  >;
};

// `ComputingProducerOptions` is DELETED: with `isCacheable` gone (§6.3) there
// is no computing-specific option left, so both hashed-input wrappers take plain
// `WrapProducerOptions`. (This also deletes the subtlest part of the current
// implementation: `registry.get` running inside the input-shaped `isCacheable`
// while the id is still registered.)
// `cache` moves out of the options bag to a positional arg, matching wrapProducer.
// `hashInput` moves into the per-branch record.

export function wrapHashedInputProducer<
  Input,
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
>(
  cache: PublicInterface<Cache<RT, Validators, Params>>,
  options: WrapProducerOptions<Params> | undefined,
  branches: { readonly [K in Covered]: ComputingBranch<Input, RT, K, Validators, Params, Covered> },
): (
  input: Input,
  // Call-time consumer `directives` restored (2026-07-29, full 1.6.0
  // parity): orthogonal to producer-stamped freshness, threaded into the
  // delegated request (collapse key, bypass skip-read, validation all come
  // from the plain wrapper underneath).
  options?: { directives?: ConsumerDirectives; signal?: AbortSignal },
) => Promise<
  Entry<SpecForId<SpecOf<RT>, IdOfResourceType<RT[Covered]>>, Validators, Params>
>;

export function wrapBulkHashedInputProducer<
  Input,
  RT extends ResourceTypes,
  Covered extends ResourceTypeName<RT>,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  ErrorType extends Error = Error,
>(
  cache: PublicInterface<Cache<RT, Validators, Params>>,
  options: WrapProducerOptions<Params> | undefined,
  branches: {
    readonly [K in Covered]: Omit<
      ComputingBranch<Input, RT, K, Validators, Params>, "produce"
    > & {
      produce: (
        // No `options`/signal: see the 2026-07-30 note in §6.7.
        inputs: readonly ReadonlyDeep<Input>[],
      ) => Promise<
        (
          | HashedInputProducerResult<Input, SpecForId<SpecOf<RT>, IdOfResourceType<RT[K]>>, Validators, Params>
          | ErrorType
        )[]
      >;
    };
  },
): (inputs: readonly Input[], options?: { signal?: AbortSignal }) => Promise<
  (Entry<SpecForId<SpecOf<RT>, IdOfResourceType<RT[Covered]>>, Validators, Params> | ErrorType)[]
>;
// Both hashed-input wrappers: coverage inferred from `branches` keys; returned
// entries narrow to the covered specs; same construction-time keyless-record
// throw as wrapProducer. An input no covered branch's `matchesInput` accepts
// throws (unchanged from the by-input-type builder's unmatched-input error).
```

### 6.5 Diagnostics channels

All four channels. Every message begins with the same two attribution fields
(`produce` carries them per element of `requests[]` instead — see below):

```ts
type Attribution = {
  /** Cache instance name (constructor `options.name`). */
  cache: string;
  /** Resource-type name from the cache's registry (`cache.classify(id)`). */
  resourceType: string;
};
```

**Why `fetch` and `produce` are two channels, not one.** They are the two spans
of the same story with different subjects and cardinalities: a `fetch` is the
consumer-side span (one per logical request); a `produce` is the origin-side
span (one per producer invocation). They relate many-to-one in two ways —
request collapsing (N callers ride 1 invocation; inlining invocation stats into
fetch messages would republish them once per rider, weighting producer
error/latency metrics by rider count unless every subscriber filters
`collapsed: false`) and bulk batching (one invocation covers `requests[]`;
per-request events can't carry batch shape) — and are temporally decoupled in
two ways: an SWR revalidation settles *after* its triggering fetch event
already shipped (live behavior — axis-care sets `maxStale` at 8+ sites), and an
`aborted` fetch settles *before* its invocation does (the collapsed producer
call keeps running and stores in the background). Even maximal inlining would
put invocation fields on only the three settled-invocation dispositions and
still need a homeless-event stream for revalidation/abort settlements — two
message kinds exist either way; separate channels is the clean distribution.
The durations also mean different things: `produce.durationMs` is invocation
time, while any fetch-level duration would be caller wait (riders wait less
than the invocation took).

The `TypedChannel` helper becomes a public export:

```ts
export type TypedChannel<T, Name extends string> = Omit<
  Channel,
  "publish" | "subscribe" | "unsubscribe"
> & {
  publish(message: T): void;
  subscribe(callback: (message: T, name: Name) => void): void;
  unsubscribe(callback: (message: T, name: Name) => void): boolean;
};
```

#### 6.5.1 `@zingage/cache:read` — what did the cache lookup find?

Published by `Cache.get` (one message) and `Cache.getMany` (one per request),
including direct callers that never touch a wrapper. Wrapper requests with
bypass directives never appear here — they skip the read entirely (§6.3).

```ts
export const CACHE_READ_CHANNEL_NAME = "@zingage/cache:read";

/** What a *completed* lookup found, evaluated against the request's directives. */
export type CacheReadFound =
  | "usable"                  // satisfiable from cache alone
  | "usable-while-revalidate" // only usable if paired with a background refresh
  | "usable-if-error"         // only usable as a producer-failure fallback
  | "none";                   // nothing this request could use
// (Reserved for future conditional revalidation: entries that are merely
// `validatable` report "none" today.)

export type CacheReadMessage = Attribution & { resourceId: string } & (
  | { found: CacheReadFound }
  // The store threw; no lookup result exists. The error still propagates to
  // the caller after this message is published. A discriminated union rather
  // than an optional `error` so the error is present exactly when it applies.
  | { found: "read-failed"; error: unknown }
);

export const cacheReadChannel: TypedChannel<CacheReadMessage, typeof CACHE_READ_CHANNEL_NAME>;
```

**Ordering guarantees (per logical request).** `read` precedes `produce`;
`store-entry` messages follow the `produce` whose invocation stored them; a
settling `fetch` is never published before the outcome it reports exists.
Beyond that, `store-entry` and `fetch` are mutually unordered — persistence
is fire-and-forget relative to serving, so subscribers must not assume
either order — and an SWR revalidation's `produce` settles after the `fetch`
it accompanied (§6.5.3).

A read that itself **fails** (the store threw) publishes `found: "read-failed"`
carrying the error — one message per request in the failed call, so per-id read
counts match the successful path — and *then* the error propagates
(`Cache.get`/`getMany` still reject). This keeps one-message-per-lookup total,
so subscribers can use the channel as a complete denominator. Under the
wrappers' default `onCacheReadFailure: "call-producer"` the request then settles
on the `fetch` channel normally (`served-from-producer` / `producer-error` /
`aborted`); under `"throw"` the wrapped call rethrows with no `fetch` message —
the request never reached a disposition — but the `read-failed` message is still
published either way.

An **aborted** read is not a failed read and publishes nothing, matching the
`throwIfAborted` fast path (the read never completed *or* failed; the caller
cancelled). Bypass requests likewise never appear at all, not even as failures.

#### 6.5.2 `@zingage/cache:fetch` — how was this logical request answered?

Published by the wrappers, once per call of the wrapped function (per request
element, for bulk) — exceptions: a cache-read failure under
`onCacheReadFailure: "throw"` rethrows before any disposition exists and emits
no *fetch* message (it does publish `read-failed` on the read channel, §6.5.1)
— **including** the bypass elements of a mixed bulk
batch, whose already-in-flight invocation keeps running (and stores on
success) but whose answers the rejected call never delivers, so their fetch
messages are suppressed rather than later claiming `served-from-producer`;
and pre-dispatch validation failures (`UnclassifiableIdError`,
`AmbiguousResourceTypeError`, `NoProducerForResourceTypeError`) likewise
throw with no fetch message — the request never reached a disposition. A
bulk producer that returns fewer results than requests (or an `undefined`
element) violates its contract, poisoning the positional (result, request)
pairing — so the **whole invocation fails**: nothing is stored, the
`produce` message reports `outcome: "error"`, **every** element settles as
`producer-error` (exactly once), and the call rejects. This is the successor of today's `result` channel, with the
"what role did the cache play" question answered explicitly instead of mixing
read-outcomes with not-consulted reasons.

```ts
export const CACHE_FETCH_CHANNEL_NAME = "@zingage/cache:fetch";

export type CacheFetchMessage = Attribution & {
  resourceId: string;
  /**
   * True if this request's own SETTLEMENT rode an already-in-flight producer
   * call -- it was answered (or errored/aborted) via an invocation some
   * other caller initiated. Cache-served settlements report false even when
   * the request attached a background revalidation to an in-flight
   * invocation: a `served-stale-while-revalidating` rider counts in the
   * produce channel's `collapsedCallerCount` but not here, because its
   * settlement was the cached entry, not the invocation.
   *
   * In the base (not the union) because it doesn't co-vary with the bypass
   * flag: e.g. `served-stale-after-error` can be collapsed (a rider on a
   * failed shared invocation falling back to its own if-error entry) but
   * never bypassed.
   */
  collapsed: boolean;
} & (
  | {
      // Dispositions reachable only via a cache read — which bypass requests
      // skip entirely (§6.3), making this branch sound by construction rather
      // than statistically. (Without skip-read, `maxAge: 0` can be satisfied:
      // age is a ms-resolution float compared with strict `>`, so a
      // same-millisecond entry has age 0 ≤ 0, and cross-pod clock skew makes
      // age *negative* — the producer-stamped `date` is the birth basis.)
      disposition:
        | "served-from-cache"                // 1.6.0 "hit"
        | "served-stale-while-revalidating"  // 1.6.0 "stale_while_revalidate"
        | "served-stale-after-error";        // NEW (stale-if-error; invisible today)
      directivesImpliedBypass?: false;
    }
  | {
      disposition:
        | "served-from-producer"  // 1.6.0 "miss" / "bypass"
        | "producer-error"        // NEW (nothing servable; error propagated)
        | "aborted";              // NEW (caller's signal fired first)
      /**
       * True iff the consumer's directives forced producer contact regardless
       * of cache contents (`isRequestingCacheBypass`: `maxAge: 0`). A pure
       * request property — and any of these three dispositions can be
       * bypass-triggered (the producer trip can fail or be abandoned).
       * Lets hit-rate dashboards separate bypass traffic from real misses.
       */
      directivesImpliedBypass: boolean;
    }
);

export const cacheFetchChannel: TypedChannel<CacheFetchMessage, typeof CACHE_FETCH_CHANNEL_NAME>;
```

Mapping from 1.6.0 `CacheResultOutcome`: `hit → served-from-cache`; `miss →
served-from-producer, directivesImpliedBypass: false`; `bypass →
served-from-producer, directivesImpliedBypass: true`; `stale_while_revalidate
→ served-stale-while-revalidating`; `uncacheable` has **no successor** — it was
emitted only from the `isCacheable` pass-through path, deleted in §6.3.
`CacheResultOutcome`, `CACHE_RESULT_CHANNEL_NAME`, `cacheResultChannel`, and
`CacheResultMessage` are **deleted**. (1.6.0's `bypass` meant "requested bypass
*and* missed" — the freak age-≤0 hit reported `hit`; the new flag is a pure
request property, well-defined because of skip-read.)

#### 6.5.3 `@zingage/cache:produce` — one message per actual producer invocation

Published by the wrappers when a producer call settles — foreground misses AND
background revalidations (whose outcome is invisible today and arrives after the
fetch event). Producer latency and error rate live here.

```ts
export const CACHE_PRODUCE_CHANNEL_NAME = "@zingage/cache:produce";

export type CacheProduceMessage = {
  cache: string;
  /**
   * Why the producer was contacted — the invocation's INITIATING cause.
   * Bypass never mixes with the other two (the collapse key includes the
   * request's directives, so a `maxAge: 0` caller and a plain-miss caller
   * never share an invocation), but miss and revalidation callers use
   * identical directives and CAN share one: a same-key miss arriving while a
   * revalidation is in flight rides it (and vice versa) without re-labeling
   * the trigger.
   */
  trigger: "miss" | "revalidation" | "bypass";
  /**
   * The requests this invocation covered. Length 1 except for bulk producers
   * (which batch within one resource type, so all elements share resourceType).
   */
  requests: readonly { resourceType: string; resourceId: string }[];
  /**
   * Total logical callers this invocation served: the initiator plus every
   * rider that collapsed onto it (≥ 1; a background revalidation with no
   * waiting foreground caller reports 1). Counts ATTACHMENT, not settlement
   * dependence: an SWR caller whose background revalidation rode this
   * invocation is counted here while its own fetch reports
   * `collapsed: false` (§6.5.2) -- so Σ(collapsedCallerCount − 1) ≥ the
   * number of `collapsed: true` fetches. May also undercount by riders that
   * attach in the settlement's microtask window (served by the just-settled
   * invocation after this count was read).
   */
  collapsedCallerCount: number;
  outcome: "success" | "error";
  durationMs: number;
};

export const cacheProduceChannel: TypedChannel<CacheProduceMessage, typeof CACHE_PRODUCE_CHANNEL_NAME>;
```

#### 6.5.4 `@zingage/cache:store-entry` — one message per stored entry

Published by `Cache.store()`. Successor of 1.6.0's
`store-entry-result` channel (renamed; `STORE_ENTRY_RESULT_CHANNEL_NAME`,
`storeEntryResultChannel`, `StoreEntryResultMessage` are **deleted**).
Attribution comes from classifying the entry's own id — which is what makes
supplementals and direct stores correctly attributed with no threading.

```ts
export const CACHE_STORE_ENTRY_CHANNEL_NAME = "@zingage/cache:store-entry";

export type CacheStoreEntryMessage = Attribution & {
  resourceId: string;
  vary: Vary<AnyParams>;
  validators: Partial<AnyValidators>;
  /** See StoreEntryRelationship (unchanged). Undefined when not comparable. */
  relationshipToExistingStoredData: StoreEntryRelationship | undefined;
};

export const cacheStoreEntryChannel: TypedChannel<CacheStoreEntryMessage, typeof CACHE_STORE_ENTRY_CHANNEL_NAME>;
```

#### 6.5.5 Dropped-directive telemetry — DELETED

The 1.6.0 feature that recorded/published when a NaN-containing
`storeFor`/`maxStale` producer directive was discarded during normalization is
removed outright, with no attributed successor: `DROPPED_DIRECTIVE_CHANNEL_NAME`,
`DroppedDirectiveMessage`, `droppedDirectiveChannel`, and the internal
`publishDroppedDirective` helper are all **deleted**. The *dropping itself* is
unchanged — `normalization.ts` still discards NaN-containing directives; it
just no longer reports doing so. Rationale: the only consumer never subscribed
to the channel, and a producer minting NaN directives is a bug to catch in
review/tests, not a production signal worth a permanent channel.

### 6.6 Explicitly unchanged exports

`CacheSpec`, `SpecForId`, `ContentForId`; `AnyParams`, `AnyParamValue`;
`AnyValidators`; `ConsumerRequest`, `ConsumerDirectives`, `ConsumerMaxStale`;
`ProducerResult`, `ProducerResultResource`, `ProducerResultResourceObject`,
`ProducerResultResourceForId`, `Vary`, `ProducerDirectives`, `ProducerMaxStale`;
`RequestPairedProducerResult`;
`Entry`, `EntryForId`, `JsonifiedEntry`, `Normalized*`;
`Store`, `StoreEntryInput`, `StoreEntryResult`, `StoreEntryRelationship`,
`StoreGetManyRequest`, `StoreGetManyResult`;
`MemoryStore`, `PostgresStore` (+ `PostgresStoreSupportedParams`), `SqliteStore`
(+ its spec/param types); `collapsedTaskCreator`; `naiveGetMany`;
`restoreInfinityInDirectives`; `entryUtils`; `requestVariantKeyForVaryKeys`,
`resultVariantKey`, `variantMatchesRequest`, `VariantKey`, `VaryKeys`;
`Logger`, `ComponentName`, `components`; `jsonStringify`/`jsonParse`/`JsonOf`
re-exports.

**The `Store` interface does not change.** Stores never see names or resource
types; classification is entirely a `Cache` concern. Every existing store
implementation (and the monorepo's Postgres tables) works as-is.

### 6.7 Ratified implementation deviations (2026-07-29)

TS 5.9 rejected or failed to infer through some doc-exact notations above;
the shipped `.d.ts` departs mechanically while preserving resolved types at
every valid call site (probe-verified): getMany/bulk per-slot ids wrap in
`Extract<…, SpecOf<RT>["id"]>` (identity at valid sites); `IdOfResourceType`
uses `infer Id extends string`; the hashed-input wrappers constrain
`Covered extends string` with per-key conditional gating (the dependent
constraint form collapses `Input` inference to `unknown`);
`PartialConsumerRequest` keeps its 1.6.0 `ReadonlyDeep<MakeKeysOptional<…>>`
definition (§6.3's "unchanged" label wins over its illustrative rendering).
Ratified consequences of the specced signatures: wrapped functions no longer
expose a `.cache` property (re-ratified 2026-07-29 with the capability-leak
rationale accepted — a fetcher is a narrow read-shaped token; `.cache` hands
every holder store/delete over the whole multi-type cache); stores for
narrowed registries need explicit spec args
(`new MemoryStore<SpecOf<typeof rts>>()`).

**Restored to full 1.6.0 parity (2026-07-29, user decision reversing two
initially-ratified cuts):** hashed-input wrappers take call-time `directives`
again (the cut's "fragile Input inference" rationale was wrong — inference
happens at wrap time from the branches record, and call options participate
in none of it), and hashed-input supplementals are no longer confined to the
producing branch: input-keyed supplementals may target any COVERED branch
(routed by `matchesInput`, hashed by the routed branch's `hashInput`,
mint-checked eagerly), and id-keyed supplementals may target ANY registry
type, exactly like plain producers' (§6.4). Driving rationale: production's
"hashed-input producer" archetype (e.g. zendesk's credential-privacy use of
`wrapHashedInputProducer`, which does I/O, not pure computation) wants plain
`wrapProducer` semantics with a derived key, so the two consumer-facing
contracts shouldn't diverge. Call-time `params` stays out — it never existed
on hashed-input wrappers, and anything that changes a computed output belongs
in the input (a second identity axis would compete with the hash).
`ComputingBranch.matchesInput` was typed plain-optional, with
required-when-multi enforced by a construction-time throw and silently
ignored when single (resolving §11's overloads question). **Both of those,
and the inference limit once recorded here, are moot as of 2026-07-30**: the
builder takes the guard positionally, so a matcher-less multi-branch producer
is unconstructible and a single-branch one has no guard to ignore; and `Input`
is no longer a wrapper type parameter to lose (each `.when` infers its own).
The claim that pre-typed branch functions degraded `Input` to `unknown` was
also wrong on its own terms — probing five shapes (inline annotated closures,
hoisted pre-typed functions, a hoisted record, and the multi-branch shape the
tests used) inferred correctly in all of them, so the explicit type arguments
those call sites carried were never necessary. See
[2026-07-30-hashing-producer-builder.md](./2026-07-30-hashing-producer-builder.md).

Post-review adjudications (2026-07-29, adversarial-review round):

- **`fetch.collapsed` is settlement-centric — reviewed and ratified as
  conforming.** The SWR path hardcodes `collapsed: false` because a
  stale-while-revalidating caller's settlement is the cached entry, never
  the invocation its background revalidation may have ridden; only
  settlements that depend on a shared invocation (`served-from-producer`,
  `producer-error`, `served-stale-after-error`, aborted-while-waiting)
  report riding. Consequence: `produce.collapsedCallerCount` counts
  attachment, so the two channels reconcile as an inequality, not an
  equation (§6.5.2/§6.5.3 docstrings).
- **Throwing registry guards classify as non-matching**, with the error(s)
  surfaced as `UnclassifiableIdError.cause` (§6.1). Without this, the §6.1
  `jsonParse` guard idiom leaks bare `SyntaxError`s with no cache/id
  attribution on malformed ids, contradicting §7's simulation.
- **`Cache.delete` after `close()`** follows `onStoreAfterClose` (deletes
  are writes): "throw" throws the same closed error as `store`; "no-op"
  silently does nothing.
- **Hashed-input wrappers emit no `aborted` fetch for aborts observed before
  delegation** (before/during `matchesInput`/`hashInput`/mint-check): the
  minted id — the request's cache identity — doesn't exist or isn't
  validated yet, so no attributable fetch message is possible. Aborts from
  delegation onward publish `aborted` normally via the plain wrappers.
- **The wrappers snapshot the producers record's own entries at wrap time**,
  so post-wrap mutation of the caller's record cannot change coverage
  (matching the type-level `Covered`, which is fixed at the call site).

PR #13 review round (2026-07-30, user decisions):

- **The three `RequestPairedProducer` forms collapse to one, amending §6.6.**
  §6.6 previously listed "`RequestPairedProducer` (all three forms)" as an
  unchanged export. Audit during review found that *none* of the three had a
  single reference in the implementation: the wrappers dispatch through the
  per-resource-type producer records (`ResourceTypeProducer` /
  `BulkResourceTypeProducer`) and erase internally to `LooseProducer` /
  `LooseBulkProducer`, so the conditional's only consumer was a type-level test
  asserting that the conditional dispatched — a test of the conditional by the
  conditional. `SingleIdTypeRequestPairedProducer` and the conditional
  `RequestPairedProducer` are therefore **deleted**, and
  `MultiIdTypeRequestPairedProducer` is **renamed** to `RequestPairedProducer`
  (it was already the shape internal code operated against). The
  `IsSingleType<T>` helper in `types/utils.ts`, whose sole consumer was that
  conditional, is deleted with it — it was never exported publicly. Retained
  from the deleted test block: the behavioral case that a sole-type cache's
  producer stays writable as a vanilla `async (req) => …` lambda with no
  dispatch helper. Also corrected in passing: the doc comment on
  `requestPairedProducerResultToResources` credited `RequestPairedProducer`'s
  signature as the (id, content) correlation backstop; in 2.0 that backstop is
  the per-type producer records, which pin each producer's `req.id` to its own
  registry branch.

- **Producer types drop their `options?: { signal?: AbortSignal }` parameter.**
  §6.4 carried it forward marked "UNCHANGED from 1.6.0", but 2.0 has no code
  path that passes it: every producer invocation runs inside the wrappers'
  collapsed-invocation task, which is shared between logical callers and so has
  no single caller's signal it could forward without letting one caller cancel
  another's in-flight work. 1.6.0's one non-collapsed producer call — the
  `isCacheable` pass-through — was deleted in §6.3, and it was the *only* reason
  the parameter was ever populated. Leaving it declared meant a producer author
  could write `options.signal`-aware cancellation that provably never runs, so
  it is removed from `ResourceTypeProducer`, `BulkResourceTypeProducer`,
  `RequestPairedProducer`, the internal `LooseProducer`/`LooseBulkProducer`, and
  both computing-branch `produce` shapes. The **wrapped functions** keep their
  `{ signal }` parameter unchanged — they use it, forwarding to `Cache.get`/
  `getMany` and racing each caller's own wait (`raceWithSignal`) so aborts are
  still honored per caller. Removing it also deleted a dead branch: the
  hashed-input wrappers' internal producers called
  `producerOptions ? branch.produce(input, producerOptions) : branch.produce(input)`,
  whose first arm was unreachable because the plain wrappers invoke producers as
  `producer(req)` with no second argument. Source-compatible for producer
  implementations that declared the parameter as optional (a target signature
  with fewer parameters still accepts them) — no test in the suite used it.

- **A failed cache read now publishes `found: "read-failed"` on the read
  channel, amending §6.5.1.** Previously a throwing store emitted *nothing*:
  `Cache.get`/`getMany` awaited the store with no `catch`, and `publishRead` ran
  only after the await. The gap was worst under the wrappers' default
  `onCacheReadFailure: "call-producer"`, which absorbs the store error and
  substitutes an empty lookup result — so the request went on to publish an
  ordinary producer-path `fetch`, making a store failing 100% of reads
  indistinguishable on the channels from a pure cache-miss workload (same
  producer traffic, same dispositions, no signal naming the cause). Shape
  chosen: a `found: "read-failed"` variant carrying `error`, modeled as a
  discriminated union (`{ found: CacheReadFound } | { found: "read-failed";
  error: unknown }`) rather than a flat optional `error`, so the error is
  present exactly when it applies; and `CacheReadFound` is exported separately
  so the lookup-result → `found` mapping stays total. Rejected alternative: a
  fifth `read-error` channel — it would break the read channel's
  one-message-per-lookup invariant, which is most of its value for anyone
  building a hit-rate denominator. Emitted **per request** in a failed
  `getMany`, so per-id counts match the successful path. Aborted reads publish
  nothing (an abort is not a failure, and the pre-existing `throwIfAborted` fast
  path already emitted nothing — staying silent keeps that consistent instead of
  inflating read-failure rates with client cancellations).

---

### 6.8 Cache API simplification (2026-07-30 review round)

Four changes from a review of §6.1/§6.2, all breaking, all in the same PR as the
single-producer-function change. The fourth (the store's spec no longer having to
match the registry exactly) came out of noticing that the first three kept
running into `Store`'s invariance.

**1. `Cache` takes one options bag; `store` moved into it.** Was
`new Cache(store, { name, resourceTypes, … })`, now
`new Cache({ store, name, resourceTypes, … })`, with the shape exported as
`CacheOptions<RT, Validators, Params>`. The separate positional store dated from
when `options` could be omitted; §6.2 made `name` and `resourceTypes` required,
so there is no longer a call shape in which passing the store alone says
anything. The `InvariantOf<Params>` wrapper and the comment explaining why it is
needed move to the `store` field unchanged.

**2. `soleResourceType` is deleted, not just narrowed.** It is gone from the
package entirely -- no longer exported, and its ten call sites inlined as
`resourceType<C>()({ matches: (id): id is string => typeof id === "string" })`.
`singleTypeCacheOptions` (below) is now the only single-type surface.

What made the removed form unsound was the *combination* of a narrowed `Id` type
parameter with a guard that accepted every string: the guard admits any id, so a
malformed one classifies happily and is stored under a spec whose type says such
an id cannot exist. 6.1's own docstring named the only enforcement as call-site
compile checks -- and a cast or an untyped boundary (parsed JSON, a queue
payload) walks past those, which is precisely how ids arrive in practice.

A narrower id space now requires a real runtime guard, either via
`singleTypeCacheOptions`' `validateId` or by writing the one-entry registry with
`resourceType<C>()({ matches })`. Both narrowed cases in this repo's own fixtures
converted to one-line guards (a prefix check, and a JSON-parsing guard for the
branded `JsonOf<…>` id).

This also invalidated a rationale comment in `requestPairedProducerUtils.ts`,
which credited the *per-type producer records* with being "the user-facing
(id, content) correlation backstop" and used that to justify two
`as unknown as` casts. Corrected there. There is no runtime backstop and never
was: the registry's `matches` is an *id* predicate, and `resourceType<Content>()`
is type-only for content, so nothing exists to validate content against without
adding content validators to the registry.

**3. New `singleTypeCacheOptions<Content>()({ store, name, … })`.** Builds
`CacheOptions` for a one-resource-type cache so the caller does not have to
invent a name for the type or nest a one-entry registry literal. The type is
named after the cache unless `resourceTypeName` overrides it; that name reaches
diagnostics only (it is never part of a store key -- verified), so naming it
after the cache cannot invalidate entries, and it keeps `resourceType`
meaningful across caches rather than collapsing every sole-type cache into one
shared literal. Spreadable, so any other `CacheOptions` field can be set
alongside.

Curried for the same reason `resourceType` is: `Content` has no inference
source, and TS has no partial type-argument inference.

The registry it returns is keyed by an index signature, so `classify()` returns
`string` on such a cache rather than the literal name. `SpecOf` of that registry
is still exactly `CacheSpec<Id, Content>`, so the id space and content type stay
precise; only the name is imprecise, which is the thing the helper exists to let
you stop thinking about.

#### `validateId`, and where the guard requirement lives

`validateId` narrows the id space below `string`, and `Id` is inferred from it
and from nothing else. The store deliberately does not mention `Id`: it is typed
`Store<StoreSupportedTypes, …>` and only checked for coverage (see 4 below), so
`Id` has exactly one source -- the guard that enforces it.

The requirement that a narrower `Id` come with a guard is carried by an
intersected conditional rather than a second call signature:

```ts
{ …; validateId?: (id: string) => id is Id }
  & ([string] extends [Id] ? unknown : { validateId: (id: string) => id is Id })
```

`validateId` has to be optional in the base object to be an inference site at
all; the carrier makes it required as soon as `Id` is narrower than `string`. An
explicit type argument is fixed before the carrier resolves, so naming a narrow
`Id` without a guard is rejected, and an *inferred* narrow `Id` could only have
come from a guard. One signature replaces two, and the error a caller sees is
"`validateId` is missing" rather than "no overload matches this call".

Two corrections to earlier iterations, both from probing rather than reasoning:

- An attempt to wrap the store's `Id` in `NoInfer` so the guard would win does
  not do what it reads like -- it leaves `Id` with no inference candidate at all,
  so it falls back to its `string` constraint and the narrowing is discarded
  outright. (An intermediate diagnosis, that `NoInfer` "makes the guard win at
  the cost of every caller spelling out the store spec", was simply wrong.)
- While the store still carried `CacheSpec<Id, Content>`, an untyped
  `new MemoryStore()` contributed a competing `string` candidate that beat the
  guard's, so a guarded cache with an untyped store silently lost its type-level
  narrowing. Taking `Id` out of the store's type removes the competition; the
  narrowing now holds regardless of how the store is typed.

Coverage is *not* checked inside the helper, and cannot be. The check compares
`CacheSpec<Id, Content>` against the store's spec, and a conditional spelled over
`Id` is resolved while checking the `store` property -- before `validateId` has
contributed its inference, since a type predicate's narrowing lands in a later
pass. It therefore resolves against `Id`'s default of `string` and rejects every
store typed more narrowly (probed: a store typed for exactly the guard's id space
failed its own coverage check). So the helper hands back the store's plain type
and `new Cache` does the checking, with `Id` already fixed. For that to work the
returned `store` field is re-declared *without* `CacheOptions`' coverage guard:
leaving the guard on would have the helper's own asserted return type claim the
guard's phantom property, and an under-covering store would sail through.

**4. The store may support a WIDER spec than the cache's registry.** `Cache` and
`CacheOptions` gained a final, defaulted `StoreSupportedTypes extends CacheSpec =
SpecOf<RT>`; the store's field is
`Store<StoreSupportedTypes, …> & (SpecOf<RT> extends StoreSupportedTypes ?
unknown : { __storeMustSupportAtLeast: SpecOf<RT> })`.

`Store` is invariant in `Spec` -- it sits in `store()`/`delete()`'s parameters
*and* `get()`/`getMany()`'s return types -- so `Store<Wide>` is not assignable to
`Store<Narrow>` even though, for any id the narrow cache asks for, the wide store
returns exactly the same thing. Since most stores are general-purpose, requiring
an exact match forced callers to re-instantiate them with artificially narrowed
type arguments.

This limitation is **new in 2.0**, and worth understanding as a consequence of
the registry rather than an inherited wart: through 1.6.0, `Cache<Spec>` took
`Spec` directly and *inferred it from the store*, so the cache became exactly as
wide as its store and a mismatch was unrepresentable. Making the registry the
source of truth is what turned the store into something *checked against* an
independently-determined spec.

Rather than fight the variance, the store's own spec is captured and only
*checked* for coverage. Probed findings behind that choice:

- `store()` and `delete()` are already fine wide->narrow (parameter positions).
- `get` blocks it, and relaxing `Id extends Spec["id"]` to `Id extends string` --
  making `Spec` output-only -- does **not** help. Relating two generic signatures
  instantiates the type parameter at its constraint and compares once, so TS
  checks the worst case; at `Id = string` the wide store's return genuinely *is*
  wider. The pointwise argument is true per concrete id but TS never reasons
  pointwise.
- A declaration-site annotation cannot assert past it either: `in Spec` (the
  direction that would permit a wider store) is rejected with TS2636 while `Spec`
  appears in a return type. The same annotation on a Store-shaped type with only
  `store`/`delete` is accepted, and a wide instance *is* then assignable -- so
  the only route to genuine variance is taking `Spec` out of the read return
  types and letting `Cache` do the id->content narrowing. That is arguably the
  right layering and is deliberately **not** attempted here: it changes the
  `Store` contract and every implementation.

Cost of the chosen approach: three documented casts at the store boundary inside
`Cache`, because `SpecForId<StoreSupportedTypes, Id>` does not reduce to
`SpecForId<SpecOf<RT>, Id>` under a generic `StoreSupportedTypes`. Every id
involved came from this cache and is therefore in `SpecOf<RT>`, so the two agree
pointwise -- the same fact TS cannot see.

`singleTypeCacheOptions` gets the same latitude, so one general-purpose store can
back several single-type caches; it threads its own `StoreSupportedTypes` through
and lets the constructor do the checking, for the inference-ordering reason
described under `validateId` above.

Ordering note: `StoreSupportedTypes` is **last and defaulted**. An intermediate
iteration inserted it second, which silently shifted `Validators` into its slot
at every 3-argument `CacheOptions<RT, Validators, Params>` use -- and in an
overloaded call that misalignment crashed `tsc` 5.9.3 outright with
`Debug Failure. No error for last overload signature` rather than producing a
diagnostic.

#### Test coverage

- `singleTypeCacheOptions` names the type after the cache and that name is what
  reaches the `read`/`fetch` channels; `resourceTypeName` overrides it without
  touching `cache.name`; other `CacheOptions` survive a spread
  (`onGetAfterClose: "act-empty"` still governs after close); the sole type
  classifies every id (property-based).
- A one-entry registry with a real guard rejects a nonconforming id with
  `UnclassifiableIdError` **before the store is touched** (store spy) and
  publishes nothing -- the enforcement the removed form lacked.
- Compile fixtures: `store`/`name`/`resourceTypes` each required; the helper
  keeps `content` exact while `classify()` widens to `string`; `validateId`
  narrows the id space through to `Cache.get`'s request type; a wider store is
  accepted with no type arguments, and an under-covering store is rejected.
- Compile fixtures for the helper specifically: a store supporting a strictly
  wider spec backs a *narrowed* sole-type cache, and neither the store's id union
  nor its content union leaks into that cache's types; naming a narrow `Id` by
  explicit type argument without `validateId` is rejected; and at the constructor,
  both a wrong-content store and a store whose id space is narrower than an
  unguarded cache's are rejected.
- Every test in `singleProducerFn.test.ts` now runs against a store whose spec is
  strictly wider than its cache's registry, so the covering path is exercised
  throughout rather than in one fixture.

## 7. Execution pattern and simulation

Axis-care site-day visits, under the new contract:

```ts
const cache = new Cache({
  store: store,
  name: "axis_care_site_visits",
  resourceTypes: siteVisitsResourceTypes,   // §6.1: site_day | business_slice,
});

const getVisits = wrapProducer(cache, {}, {
  site_day: async (req) => {
    const data = await client.getAllVisits(parse(req.id));
    return {
      content: data,
      validators: await contentHashValidator(data), // app-side helper (canonical-json-digest.ts)
      directives: { freshUntilAge: TTL, storeFor: TTL * 2 },
      supplementalResources: await deriveBusinessVisitSlices(data),  // business_slice ids
    };
  },
  business_slice: async (req) => {/* derive one slice via the site entry */},
});
```

- **t=0, first read of `site:X` (miss):**
  `read {cache: "axis_care_site_visits", resourceType: "site_day", found: "none"}`
  → `produce {trigger: "miss", requests: [{resourceType: "site_day", resourceId}], outcome: "success", durationMs}`
  → `store-entry` ×(1 + N): one `{resourceType: "site_day", relationship: "is-new"}`,
  N × `{resourceType: "business_slice", relationship: "is-new"}` — the
  supplementals attributed to *their own* type, which flow-name threading got wrong by design
  → `fetch {resourceType: "site_day", disposition: "served-from-producer", directivesImpliedBypass: false, collapsed: false}`.

- **t=0+ε, concurrent read of the same id:** its own
  `read {resourceType: "site_day", found: "none"}` — every logical request
  performs (and reports) its own lookup per §6.5.1; only the producer
  invocation is shared — but no new `produce`;
  `fetch {…, disposition: "served-from-producer", collapsed: true}`.

- **t=1 (< TTL), read of business B's slice:**
  `read {resourceType: "business_slice", found: "usable"}` →
  `fetch {resourceType: "business_slice", disposition: "served-from-cache"}` —
  distinguishable from site-day traffic for the first time.

- **t=2 (> TTL, SWR window), site read:** `read {found: "usable-while-revalidate"}`
  → `fetch {disposition: "served-stale-while-revalidating"}` → later,
  `produce {trigger: "revalidation", outcome: "success"}` → `store-entry`
  `{relationship: "unchanged"}` if the vendor data didn't move (contentHash equal).

- **Producer outage at t=2 instead:** `produce {trigger: "revalidation", outcome: "error"}`;
  a foreground caller inside the if-error window gets
  `fetch {disposition: "served-stale-after-error"}`; outside it,
  `fetch {disposition: "producer-error"}`. All three are invisible in 1.6.0.

- **Bug: producer mints a slice id with a typo'd shape:** `Cache.store()` throws
  `UnclassifiableIdError{cacheName, id}` before persisting — today this writes a
  permanently unreadable row.

## 8. Rollout and rollback

- Ship as `@zingage/cache@2.0.0` (breaking). No feature flags — the package is
  consumed only by the monorepo, and the compiler surfaces every affected site.
- Rollback = pin the monorepo catalog back to `^1.6.0` (a lockfile revert);
  stores/tables are untouched by 2.0, so downgrade is data-safe. Entries stored
  under 2.0 remain readable by 1.6.0 and vice versa.
- Implementation context: the package lives at `github.com/joinava/cache`
  (this doc ships there under `docs/plans/`). Toolchain: `pnpm build`
  (`tsc -b`; tests run against `dist/`, so build first), `pnpm test`
  (`node --test`), `pnpm test:docker` for the Postgres/Redis store suites,
  `pnpm lint` (oxlint); `prepublishOnly` runs build + lint. Release =
  publish 2.0.0 after merge; the monorepo consumes it via the pnpm catalog.
- Datadog, in two phases. **Phase 1 (the migration PR itself): metric-
  identical.** The monorepo keeps emitting exactly today's two metrics —
  `cache.lookup` and `cache.store_entry`, same names, tags, and emission
  cases — by mapping the new channels back to the old shapes in
  `di-container.ts` (§9 step 6). No new metrics, no dashboard or Pulumi
  changes: metric continuity is itself the migration's verification signal
  (a panel discontinuity = a mapping bug). **Phase 2 (separate, later PR):
  adopt the new shapes** — `cache.fetch` (tags `cache`, `resource_type`,
  `disposition`, `bypass` from `directivesImpliedBypass`), `cache.produce`
  (tags `cache`, `resource_type`, `trigger`, `outcome`; duration histogram),
  `cache.store_entry` gaining `cache`/`resource_type` tags, and
  optionally `read` — re-pointing dashboards in the same PR (Pulumi, per
  observability-as-code) and deleting the phase-1 legacy mapping.

## 9. Monorepo migration sketch (separate PR, sized for one pass)

Authoritative site inventory: `grep -rn "cacheName:" apps/backend/src` (~43
wrapper + hashed-input sites; every current site passes one, so none tag
`"unknown"` today) and `grep -rn "new Cache" apps/backend/src` (~25 cache
constructions). The hashed-input subset is identified by call shape
(`wrapHashedInputProducer` / `computingProducerByInputType`); note 1.6.0's
hashed-input wrappers delegate to `wrapProducer` internally, so their `cacheName`s
(`ranker_*`, zendesk) flow through today's metric like any other wrapper's.

1. Catalog bump to `^2.0.0`.
2. Every `new Cache<Spec…>({
  store: store,
  ,
})` (~25 sites) → registry + name. Single-type
   caches use `singleTypeCacheOptions<Content>()` (see 6.8; `soleResourceType`
   no longer takes a second type arg) — supplying a real guard where
   the site already has a template-literal or branded id (e.g. zendesk's
   `` `zendesk-ticket-schema:${string}` `` hashed-input ids), so producers keep
   their current narrow `req.id` types. `Spec` type aliases become
   `SpecOf<typeof rts>` (or stay, with the registry `satisfies`-checked against them).
3. Every `wrapProducer(cache, { cacheName }, producer)` (~42 sites) → drop
   `cacheName` and wrap the producer as `{ <type-name>: producer }` (the
   bare-function form is gone); `producerByIdType` sites (axis-care visits,
   hhax demographics) become producer records keyed by the registry names.
4. Hashed-input sites (zendesk ticket-schema, the three staffing-planner ranker
   extraction services, and any other computing-shaped callers from the
   inventory): `cache` moves out of the options bag to the first positional
   arg, `hashInput` moves into the per-type branch record keyed by the type
   name, `cacheName` is dropped, and `computingProducerByInputType` builder
   chains become branch records (§6.4).
5. well-sky site-persons: **stays two wrappers** over the one cache — each
   covers its own type (`site_clients` / `site_caregivers`), which partial
   coverage now expresses honestly; the per-business producer memoization is
   untouched. (An earlier draft forced a merge into one two-branch record;
   no longer required.)
6. `di-container.ts` — **metric parity, no new metrics** (§8's Datadog phase
   1). Replace the two 1.6.0 subscriptions with subscriptions on `fetch` and
   `store-entry` that keep emitting exactly `cache.lookup` and
   `cache.store_entry`:

   - `cache.lookup` ← `fetch` messages ONLY. `read` and `produce` are not
     mapped: direct `Cache.get` reads were
     unmetered in 1.6.0, so mapping `read` would inflate lookup counts with
     serve-if-present traffic (business slices, knowledge rule-runs) that
     never counted before.
   - `outcome` tag mapping: `served-from-cache → "hit"`;
     `served-stale-while-revalidating → "stale_while_revalidate"`;
     `served-stale-after-error → "miss"`; `served-from-producer` /
     `producer-error` / `aborted` → `"bypass"` when `directivesImpliedBypass`,
     else `"miss"`. This is exact because 1.6.0 published at classification
     time, *before* the producer settled — producer errors, aborts while
     awaiting the producer, and stale-if-error fallbacks were all already
     counted as `miss`/`bypass` there. `uncacheable` needs no successor: it
     only ever fired from the `isCacheable` path, which has zero monorepo
     users — the tag value retires with no data-point loss.
   - `cache_name` tag: the legacy value was per-wrapper. Name every 2.0
     `Cache` exactly its old wrapper's `cacheName` (1:1 for all sites except
     the split below), making `cache_name := msg.cache` the default. Where one
     cache hosts multiple legacy names — well-sky site-persons only — recover
     via a small explicit record keyed `` `${cache}:${resourceType}` `` →
     legacy name (`site_clients → well_sky_site_clients`, `site_caregivers →
     well_sky_site_caregivers`). Axis-care visits needs no entry: both its
     resource types carried the single legacy name, which becomes the cache
     name.
   - `cache.store_entry` ← `store-entry` messages: `relationship:
     msg.relationshipToExistingStoredData ?? "not-reported"` — same
     derivation, same per-entry cardinality (the undefined-relationship cases
     — empty validators, in-call duplicate losers, store didn't check — still
     emit one message each). Do NOT add the now-available
     `cache`/`resource_type` tags in this PR.
   - The mapping is a pure function of the message: unit-test the table
     directly in the monorepo (where the mapping lives).
   - Known deltas, disclosed (counter behavior differs only here): (a)
     producer-path outcomes are emitted at settlement rather than
     classification — identical totals, timestamps shift by producer latency;
     (b) the closed age-≤0/clock-skew hole (§6.3): a `maxAge: 0` request that
     1.6.0 wrongly served from cache counted `"hit"`, now truthfully counts
     `"bypass"` (and actually reaches the producer); (c) an abort landing
     during the cache read emitted nothing in 1.6.0 but now settles as
     `aborted` → `"miss"`/`"bypass"`. All three are degenerate-rare, and (b)
     was the old metric reporting a bug. (`onCacheReadFailure: "throw"` —
     where 1.6.0 emitted nothing on a failed read — has zero monorepo users;
     every site inherits `"call-producer"`, which counts identically in both
     versions.)
   - Deletion trigger: this legacy-mapping block (and the well-sky name
     record) is deleted by §8's phase 2 when dashboards move to the new
     metrics.
7. Update `.agents/skills/caching-patterns/SKILL.md` and the agent-review
   caching rule references. (`contentHashValidator` stays app-side in
   `canonical-json-digest.ts` — no call-site changes.)

## 10. Test plan (package)

- **Classification:** exactly-one-match invariant (0 → `UnclassifiableIdError`,
  2 → `AmbiguousResourceTypeError`) on get, getMany, store (primary AND
  supplemental ids), delete; fast-check over adversarial ids (reuse the
  Object.prototype-collision arbitraries from the vary-matching suite).
- **Channel conformance, per channel:** one test per message field asserting
  the documented emission points and payloads, including: supplemental entries
  attributed to their own resource type; `collapsed: true` on riders;
  `produce` fired for background revalidations with correct `trigger`;
  `served-stale-after-error` and `producer-error` paths; bulk
  batches never mixing resource types. Read-failure coverage specifically:
  a throwing store publishes `found: "read-failed"` with the error from
  `Cache.get`, one per request from `getMany` (duplicates included, each
  attributed to its own resource type), still published under *both*
  `onCacheReadFailure` settings — with the `"throw"` case pinning that the
  read message appears while the `fetch` message does not — and an aborted
  read publishing nothing.
- **Bypass skip-read:** a `maxAge: 0` request performs no store read (assert
  via a store spy), emits no `read` event, reaches the producer, still stores
  the result, and collapses only with identical-directive peers. Regression
  fixture for the age-≤0 hole: an entry whose producer-stamped `date` is in the
  reader's future (skewed clock) must NOT be served to a `maxAge: 0` request.
- **Coverage (type-level):** `@ts-expect-error` fixtures, mirroring the design
  probe — coverage inferred from a partial record bounds the wrapped
  function's ids (covered accepted; uncovered ids and plain `string`
  rejected); producer `req` params contextually narrowed per key (no implicit
  any); non-registry keys rejected; supplemental writes may target uncovered
  types; a bare function or empty record infers `Covered = never`, making the
  returned wrapper uncallable; mismatched (branch id, content) pairs rejected;
  a one-entry registry with a real guard for a template-literal or branded `Id` rejects
  bare-`string` requests/`hashInput` returns while the no-`Id` form still
  accepts any string (probe-verified: predicate covariance lets narrowed
  guards satisfy the `ResourceTypes` index signature).
- **Coverage (runtime):** construction throws on keyless `producers`; a cast
  id whose type is outside the wrapper's coverage throws
  `NoProducerForResourceTypeError` before any store read (assert via store
  spy); two partial wrappers over one cache serve their own types
  independently.
- **Store untouched:** existing store conformance suite passes unmodified.

## 11. Open questions (for refinement)

None of these block implementation: §6 is normative as written, and each
question names a candidate refinement of a default the contract above already
takes a position on.

1. **Store-write origin attribution.** v1 ships `store-entry` with no
   initiator field (a `StoreOrigin` of `producer`/`revalidation`/`direct` was
   drafted and cut from the initial version). If per-origin panels prove
   necessary it can return additively — an optional message field plus an
   optional `store()` context param, no breaking change. Distinguishing
   primary vs supplemental writes would additionally require per-entry
   annotations or split store calls (which would break in-call same-slot
   dedup).
2. **Strict ambiguity check cost.** `classify` runs every guard per id (to
   detect overlap) rather than first-match-wins. Note the cost is per
   classification PASS, and one logical request makes several: the wrapper's own
   pass, `Cache.get`, and `Cache.store` on a miss, plus one more for
   `producerByIdType` (§10 deviation 1) and another for a hashed-input wrapper's
   `checkMintedId` — 2 passes for a bare-producer cache hit, up to 5 for a
   computing-wrapper miss, and 5×N for a bulk hashed-input call. So for a
   2-guard JSON-parsing registry (axis-care today) that is ~4–10 `jsonParse`s
   per request, not ~2; and where a guard rejects foreign ids by *throwing*,
   each pass also constructs an error with a stack capture. Acceptable, or
   should strictness be a dev-mode/`validateRegistry()` concern with
   first-match at runtime (or `classify` memoize per id)?
3. **`read` channel volume.** Wrapped paths emit both `read` and `fetch` for
   the same request (different questions, same lookup). Keep both, or make
   `read` emission opt-in per cache for high-QPS callers?
4. **Should `name` be namespaced** (e.g. enforced unique via a process-level
   registry, erroring on duplicate construction) or is convention enough?
5. **`ComputingBranch.matchesInput` sugar.** Required-when-coverage-is-multi /
   forbidden-when-single is specced via overloads; is the simpler "always
   required, trivial guard for single-coverage" preferable? *(Resolved
   2026-07-29: typed plain-optional; required-when-multi enforced by a
   construction-time throw, ignored when single — see §6.7.)*
6. **Does `fetch` need `durationMs`** (end-to-end wrapped-call latency)?
   `produce` has producer latency; a fetch duration would mean *caller wait*,
   which differs per rider (riders join a collapse window late and wait less
   than the invocation took). End-to-end may be better measured by the
   caller's own tracing.

## 12. Assumptions

- The monorepo is the only consumer (npm package is private); no deprecation
  window needed.
- Resource-type names use snake_case in the monorepo (matching existing
  `cacheName` values) — the package treats them as opaque strings.
- `soleResourceType` (via `singleTypeCacheOptions`; see 6.8) covers the long tail of single-type caches with no
  meaningful id structure; nothing forces prefixes onto them because a
  single-entry registry is trivially unambiguous. Sole types that do declare a
  narrowed `Id` get compile-time enforcement only — acceptable because the
  compiler covers every wrapper/`Cache` call site, and sites wanting runtime
  checks can use a real one-entry registry instead.
- Store-side per-type schemas/codecs are future work the registry shape
  already accommodates (add optional fields to `ResourceTypeSpec`).
