import pLimit from "p-limit";
import type { ReadonlyDeep } from "type-fest";
import type { PublicInterface } from "type-party";

import type Cache from "../Cache.js";
import type { CacheSpec } from "../types/00_CacheSpec.js";
import type {
  AnyParams,
  AnyValidators,
  ConsumerDirectives,
  ConsumerRequest,
  ProducerResultResource,
  RequestPairedProducer,
  RequestPairedProducerResult,
} from "../types/index.js";
import type { PartialConsumerRequest } from "./requestPairedProducerUtils.js";
import { wrapBulkProducer } from "./wrapBulkProducer.js";
import wrapProducer, { type WrapProducerOptions } from "./wrapProducer.js";

/**
 * ## Computing producers vs. (plain) producers
 *
 * `wrapProducer`/`wrapBulkProducer` model a cache as a **lookup of a mutable
 * entity by its id**: the caller already has the id, and the cached value is a
 * function of that id and time (e.g. "the current `User` for `user:123`"). The
 * id is the natural cache key, so the producer receives it directly.
 *
 * `wrapComputingProducer`/`wrapBulkComputingProducer` model the other common
 * case: the cached value is an **expensive-to-compute function of some input**,
 * reused whenever the same input recurs (e.g. an LLM extraction over a chunk of
 * text, a rendered template, a compiled artifact). Here the *input* is the
 * identity of the work, so a hash of the input is the natural cache key — but
 * the producer wants the original, un-hashed input to actually do the
 * computation. These wrappers encapsulate exactly that: you provide a
 * `hashInput` function and a producer that takes the full `Input`, and they
 * derive the cache id, keep the input around just long enough to hand it to the
 * producer on a miss, and otherwise behave like `wrapProducer` /
 * `wrapBulkProducer` (same caching, request-collapsing, stale-while-revalidate,
 * abort, and diagnostics behavior; see {@link WrapProducerOptions}).
 *
 * ## Supplemental resources are keyed by input, not id
 *
 * Like plain producers, a computing producer can return `supplementalResources`
 * — values it produced as a byproduct that are worth caching — and a union
 * `CacheSpec` lets those be a different content type than the primary (the
 * classic "computing a collection also yields its individual items" case). The
 * one twist that follows from keys being input-hashes: a supplemental is
 * identified by the **input** it would be computed from, not a bare id. The
 * wrapper hashes each supplemental's input the same way it hashes the primary
 * input, so a later `compute(thatInput)` finds it as a cache hit. (A bare id
 * would be unreachable, since computing lookups only ever go through
 * `hashInput`.)
 *
 * ## Correlating input to content
 *
 * For a union `CacheSpec`, `wrapComputingProducer` alone can't verify that
 * `hashInput` and the `producer` agree on a content type per input variant —
 * they're separate functions, so that coherence is the caller's responsibility
 * (just as a hand-written multi-id-type plain producer's would be). When you
 * want it enforced, build the producer with `computingProducerByInputType` —
 * the computing analog of `producerByIdType` — which dispatches per input
 * variant and checks input → content (and supplementals) end to end.
 *
 * @module
 */

/**
 * A supplemental resource returned by a computing producer: like a plain
 * {@link ProducerResultResource}, but identified by the **input** it would be
 * computed from instead of a bare `id`. The wrapper hashes that input to derive
 * the storage id, so the resource is reachable by a later `compute(input)`.
 */
export type ComputingSupplementalResource<
  Input,
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = Spec extends unknown
  ? Omit<ProducerResultResource<Spec, Validators, Params>, "id"> & {
      input: Input;
    }
  : never;

/**
 * What a computing producer returns: like a plain
 * {@link RequestPairedProducerResult}, but the primary carries no `id` (it's
 * stamped on from the derived hash) and `supplementalResources` are keyed by
 * input (see {@link ComputingSupplementalResource}).
 */
export type ComputingProducerResult<
  Input,
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = Omit<
  RequestPairedProducerResult<Spec, Validators, Params>,
  "id" | "supplementalResources"
> & {
  supplementalResources?: ComputingSupplementalResource<
    Input,
    Spec,
    Validators,
    Params
  >[];
};

/**
 * A reference-counted registry mapping a derived cache id back to the input it
 * was hashed from, so the internal producer can recover the input on a miss.
 *
 * Reference counting (rather than a plain set/delete) is required because of
 * request collapsing: several concurrent calls for the same input derive the
 * same id and may share a single producer call. If the first caller to settle
 * deleted the entry, a still-in-flight caller (or the shared producer call)
 * could find it missing. Each call `acquire`s on the way in and `release`s in a
 * `finally`; the entry is dropped only when the last holder releases it. This
 * keeps the map bounded (unlike a process-lifetime map), since nothing is
 * retained past the calls that need it.
 *
 * Soundness of "release after the wrapped call settles": the underlying
 * `wrapProducer`/`wrapBulkProducer` invoke the producer *synchronously* while
 * the wrapped call is still running (including the fire-and-forget
 * stale-while-revalidate refresh), and our internal producer reads the input as
 * its first, synchronous step — so the read always happens before the release.
 */
class InputRegistry<Input> {
  private readonly entries = new Map<
    string,
    { input: Input; refCount: number }
  >();

  acquire(id: string, input: Input): void {
    const existing = this.entries.get(id);
    if (existing) {
      existing.refCount += 1;
      // Keep the latest input. For a given id the inputs are equal (barring an
      // astronomically unlikely hash collision), so this is a no-op in practice.
      existing.input = input;
    } else {
      this.entries.set(id, { input, refCount: 1 });
    }
  }

  get(id: string): Input {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      throw new Error(
        `wrapComputingProducer: no input is registered for cache id "${id}". ` +
          "The producer was invoked for a key this wrapper did not produce, " +
          "which should be impossible (it would indicate a hash collision or a bug).",
      );
    }
    return entry.input;
  }

  release(id: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return;
    }
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      this.entries.delete(id);
    }
  }
}

/** Shared options for {@link wrapComputingProducer} / {@link wrapBulkComputingProducer}. */
type ComputingProducerOptions<
  Input,
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = Omit<WrapProducerOptions<Params>, "isCacheable"> & {
  cache: PublicInterface<Cache<Spec, Validators, Params>>;
  hashInput: (input: Input) => Spec["id"] | Promise<Spec["id"]>;
  isCacheable?(this: void, input: Input): boolean;
};

/**
 * Builds the consumer request for a derived id. The cast bridges to
 * `PartialConsumerRequest`, whose id/directives are `ReadonlyDeep`-wrapped and
 * so opaque against the plain types here while the spec is generic — the same
 * boundary coercion `wrapProducer` uses. The conditional spread avoids passing
 * `directives: undefined` (rejected under `exactOptionalPropertyTypes`).
 */
function buildComputingRequest<Params extends AnyParams, Id extends string>(
  id: Id,
  directives: ConsumerDirectives | undefined,
): PartialConsumerRequest<Params, Id> {
  return {
    id,
    ...(directives ? { directives } : {}),
  } as PartialConsumerRequest<Params, Id>;
}

/**
 * Like {@link wrapProducer}, but for a "computing producer" whose value is a
 * function of an `Input` rather than a lookup by id. You provide `hashInput`
 * (to derive the cache id from the input) and a producer that receives the full
 * input; the returned function is called with the input directly.
 *
 * See the module docs for when to use this vs. {@link wrapProducer}.
 *
 * @param options - The same options as {@link wrapProducer}, plus: `cache` (the
 *   {@link Cache} to use — in the options object rather than a separate
 *   argument); `hashInput`, which derives the cache id from the input (sync or
 *   async, and returns the cache's `id` type so callers can mint a branded key);
 *   and an `isCacheable` that receives the **input** rather than an opaque id.
 * @param producer - Computes the value from the full input on a cache miss. See
 *   {@link ComputingProducerResult} for the return shape (no primary `id`;
 *   supplemental resources keyed by input).
 */
export function wrapComputingProducer<
  Input,
  Spec extends CacheSpec,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
>(
  options: ComputingProducerOptions<Input, Spec, Validators, Params>,
  producer: (
    input: Input,
    producerOptions?: { signal?: AbortSignal },
  ) => Promise<ComputingProducerResult<Input, Spec, Validators, Params>>,
) {
  const {
    cache,
    hashInput,
    isCacheable: isInputCacheable,
    ...wrapOptions
  } = options;
  const registry = new InputRegistry<Input>();
  const hashSupplementals = makeSupplementalHasher<
    Input,
    Spec,
    Validators,
    Params
  >(hashInput);

  const wrapped = wrapProducer<Spec, Validators, Params>(
    cache,
    {
      ...wrapOptions,
      // `registry.get` runs synchronously inside `wrapProducer`'s `isCacheable`
      // check, while the id is still registered.
      ...(isInputCacheable
        ? { isCacheable: (id: string) => isInputCacheable(registry.get(id)) }
        : {}),
    },
    // `registry.get` runs synchronously before `producer` is invoked, so the
    // input is read while still registered (see InputRegistry docs). The cast
    // bridges the explicit signature to the `RequestPairedProducer` conditional
    // type, which is opaque while `Spec` is an unresolved generic — the same
    // coercion `wrapProducer` performs internally.
    (async <Id extends Spec["id"]>(
      req: ReadonlyDeep<ConsumerRequest<Params, Id>>,
      producerOptions?: { signal?: AbortSignal },
    ) => {
      const input = registry.get(req.id);
      return hashSupplementals(await producer(input, producerOptions));
    }) as unknown as RequestPairedProducer<Spec, Validators, Params>,
  );

  const wrappedComputingProducer = async (
    input: Input,
    callOptions?: { directives?: ConsumerDirectives; signal?: AbortSignal },
  ) => {
    const signal = callOptions?.signal;
    signal?.throwIfAborted();

    // `Awaited` doesn't reduce under the generic `Spec`, even though `Spec["id"]`
    // extends `string` (so can't be a thenable); the cast restores the id type.
    const id = (await hashInput(input)) as Spec["id"];
    signal?.throwIfAborted();

    registry.acquire(id, input);
    try {
      return await wrapped(
        buildComputingRequest<Params, Spec["id"]>(id, callOptions?.directives),
        signal ? { signal } : undefined,
      );
    } finally {
      registry.release(id);
    }
  };

  // Expose the cache on the returned function (for convenience, e.g. closing it).
  wrappedComputingProducer.cache = cache;

  return wrappedComputingProducer;
}

/**
 * The bulk analogue of {@link wrapComputingProducer}, layered over
 * {@link wrapBulkProducer}: looks each input's derived id up in the cache and
 * calls the producer only for the inputs that missed, computing them as a
 * single batch. Results are returned per input, aligned by index.
 *
 * See the module docs for when to use this vs. {@link wrapBulkProducer}.
 *
 * @param options - Same as {@link wrapComputingProducer}'s options.
 * @param producer - Computes the values for the missed inputs on a cache miss,
 *   returning a result (or `ErrorType`) per input, aligned by index.
 */
export function wrapBulkComputingProducer<
  Input,
  Spec extends CacheSpec,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  ErrorType extends Error = Error,
>(
  options: ComputingProducerOptions<Input, Spec, Validators, Params>,
  producer: (
    inputs: readonly Input[],
    producerOptions?: { signal?: AbortSignal },
  ) => Promise<
    (ComputingProducerResult<Input, Spec, Validators, Params> | ErrorType)[]
  >,
) {
  const {
    cache,
    hashInput,
    isCacheable: isInputCacheable,
    ...wrapOptions
  } = options;
  const registry = new InputRegistry<Input>();
  const hashSupplementals = makeSupplementalHasher<
    Input,
    Spec,
    Validators,
    Params
  >(hashInput);

  const wrapped = wrapBulkProducer<Spec, Validators, Params, ErrorType>(
    cache,
    {
      ...wrapOptions,
      // `registry.get` runs synchronously inside `wrapBulkProducer`'s
      // `isCacheable` check, while the id is still registered.
      ...(isInputCacheable
        ? { isCacheable: (id: string) => isInputCacheable(registry.get(id)) }
        : {}),
    },
    // Each `registry.get` runs synchronously (while mapping) before `producer`
    // is invoked, so every input is read while still registered.
    (reqs, producerOptions) => {
      const inputs = reqs.map((req) => registry.get(req.id));
      return producer(inputs, producerOptions).then((results) =>
        Promise.all(
          results.map(async (result) =>
            result instanceof Error ? result : hashSupplementals(result),
          ),
        ),
      );
    },
  );

  const wrappedBulkComputingProducer = async (
    inputs: readonly Input[],
    callOptions?: { directives?: ConsumerDirectives; signal?: AbortSignal },
  ) => {
    const signal = callOptions?.signal;
    signal?.throwIfAborted();

    // `Promise.resolve` since `hashInput` may be synchronous; cast for the same
    // reason as the single-producer variant.
    const ids = (await Promise.all(
      inputs.map((input) => Promise.resolve(hashInput(input))),
    )) as Spec["id"][];
    signal?.throwIfAborted();

    ids.forEach((id, index) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- index-aligned with `ids`
      registry.acquire(id, inputs[index]!);
    });
    try {
      return await wrapped(
        ids.map((id) =>
          buildComputingRequest<Params, Spec["id"]>(id, callOptions?.directives),
        ),
        signal ? { signal } : undefined,
      );
    } finally {
      ids.forEach((id) => registry.release(id));
    }
  };

  // Expose the cache on the returned function (for convenience, e.g. closing it).
  wrappedBulkComputingProducer.cache = cache;

  return wrappedBulkComputingProducer;
}

// Cap concurrent supplemental-input hashing so a result with many supplementals
// (and a possibly-async `hashInput`) doesn't flood the event loop.
const SUPPLEMENTAL_HASH_CONCURRENCY = 10;

/**
 * Builds the function that turns a {@link ComputingProducerResult} into the
 * plain {@link RequestPairedProducerResult} the underlying producer machinery
 * expects, by hashing each supplemental resource's `input` into its storage id.
 *
 * The casts reconstruct the canonical result shape from the computing result
 * (which differs only by how supplementals are keyed); TS can't track the
 * distributive transform across the `Omit`/re-add.
 */
function makeSupplementalHasher<
  Input,
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
>(hashInput: (input: Input) => Spec["id"] | Promise<Spec["id"]>) {
  // One limiter shared across every call of the returned hasher.
  const limit = pLimit(SUPPLEMENTAL_HASH_CONCURRENCY);
  return async (
    result: ComputingProducerResult<Input, Spec, Validators, Params>,
  ): Promise<RequestPairedProducerResult<Spec, Validators, Params>> => {
    const { supplementalResources, ...primary } = result;
    if (!supplementalResources || supplementalResources.length === 0) {
      return primary as unknown as RequestPairedProducerResult<
        Spec,
        Validators,
        Params
      >;
    }

    const hashed = await Promise.all(
      supplementalResources.map((resource) =>
        limit(async () => {
          const { input, ...rest } = resource;
          return { ...rest, id: await Promise.resolve(hashInput(input)) };
        }),
      ),
    );

    return {
      ...primary,
      supplementalResources: hashed,
    } as unknown as RequestPairedProducerResult<Spec, Validators, Params>;
  };
}
