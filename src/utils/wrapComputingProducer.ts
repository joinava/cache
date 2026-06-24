import type { ReadonlyDeep } from "type-fest";
import type { PublicInterface } from "type-party";

import type Cache from "../Cache.js";
import type { CacheSpec } from "../types/00_CacheSpec.js";
import type {
  AnyParams,
  AnyValidators,
  ConsumerDirectives,
  ConsumerRequest,
  RequestPairedProducer,
  RequestPairedProducerResult,
} from "../types/index.js";
import type { PartialConsumerRequest } from "./requestPairedProducerUtils.js";
import { wrapBulkProducer, type BulkProducer } from "./wrapBulkProducer.js";
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
 * @module
 */

/**
 * Derives the cache id for a computing producer from its input. May be sync or
 * async (e.g. to offload a large hash to a worker pool). Returns the cache's
 * `id` type, so callers can mint a branded key type from the hash and have the
 * type system prove the right input fields went into it.
 */
export type InputHasher<Input, Spec extends CacheSpec> = (
  input: Input,
) => Spec["id"] | Promise<Spec["id"]>;

/**
 * Options for {@link wrapComputingProducer} / {@link wrapBulkComputingProducer}.
 *
 * Identical to {@link WrapProducerOptions}, except:
 * - `hashInput` (required) derives the cache id from the input.
 * - `isCacheable`, if provided, receives the **input** rather than an id, since
 *   the input — not the opaque hash — is what a caller can meaningfully decide
 *   cacheability from.
 */
export type WrapComputingProducerOptions<
  Input,
  Spec extends CacheSpec,
  Params extends AnyParams = AnyParams,
> = Omit<WrapProducerOptions<Params>, "isCacheable"> & {
  hashInput: InputHasher<Input, Spec>;
  isCacheable?(this: void, input: Input): boolean;
};

/**
 * Per-call options for the function returned by {@link wrapComputingProducer} /
 * {@link wrapBulkComputingProducer}: the consumer-side cache directives (e.g.
 * `maxAge` to bypass, `maxStale` to tolerate staleness) and an abort signal.
 */
export type ComputingProducerCallOptions = {
  directives?: ConsumerDirectives;
  signal?: AbortSignal;
};

/**
 * A producer for {@link wrapComputingProducer}: computes the value from the
 * full `Input` (never an id). Returns the same {@link RequestPairedProducerResult}
 * shape as a plain producer — the cache id is stamped on from the request, so
 * the result must not include one.
 */
export type ComputingProducer<
  Input,
  Spec extends CacheSpec,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
> = (
  input: Input,
  options?: { signal?: AbortSignal },
) => Promise<RequestPairedProducerResult<Spec, Validators, Params>>;

/**
 * The bulk analogue of {@link ComputingProducer}: computes values for an array
 * of inputs, returning a result (or `ErrorType`) per input, aligned by index.
 */
export type BulkComputingProducer<
  Input,
  Spec extends CacheSpec,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  ErrorType extends Error = Error,
> = (
  inputs: readonly Input[],
  options?: { signal?: AbortSignal },
) => Promise<
  (RequestPairedProducerResult<Spec, Validators, Params> | ErrorType)[]
>;

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

/**
 * Like {@link wrapProducer}, but for a "computing producer" whose value is a
 * function of an `Input` rather than a lookup by id. You provide `hashInput`
 * (to derive the cache id from the input) and a producer that receives the full
 * input; the returned function is called with the input directly.
 *
 * See the module docs for when to use this vs. {@link wrapProducer}.
 *
 * @param cache - Where produced values are stored.
 * @param options - See {@link WrapComputingProducerOptions}.
 * @param producer - Computes the value from the full input on a cache miss.
 */
export function wrapComputingProducer<
  Input,
  Spec extends CacheSpec,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
>(
  cache: PublicInterface<Cache<Spec, Validators, Params>>,
  options: WrapComputingProducerOptions<Input, Spec, Params>,
  producer: ComputingProducer<Input, Spec, Validators, Params>,
) {
  const { hashInput, isCacheable: isInputCacheable, ...wrapOptions } = options;
  const registry = new InputRegistry<Input>();

  // `registry.get` runs synchronously before `producer` is invoked, so the
  // input is read while still registered (see InputRegistry docs). The cast
  // bridges the explicit signature to the `RequestPairedProducer` conditional
  // type, which is opaque while `Spec` is an unresolved generic — the same
  // coercion `wrapProducer` performs internally.
  const internalProducer = (<Id extends Spec["id"]>(
    req: ReadonlyDeep<ConsumerRequest<Params, Id>>,
    producerOptions?: { signal?: AbortSignal },
  ) =>
    producer(
      registry.get(req.id),
      producerOptions,
    )) as unknown as RequestPairedProducer<Spec, Validators, Params>;

  const wrapped = wrapProducer<Spec, Validators, Params>(
    cache,
    {
      ...wrapOptions,
      ...(isInputCacheable
        ? { isCacheable: (id: string) => isInputCacheable(registry.get(id)) }
        : {}),
    },
    internalProducer,
  );

  const wrappedComputingProducer = async (
    input: Input,
    callOptions?: ComputingProducerCallOptions,
  ) => {
    const signal = callOptions?.signal;
    signal?.throwIfAborted();

    // `Awaited` doesn't reduce under the generic `Spec`, even though `Spec["id"]`
    // extends `string` (so can't be a thenable); the cast restores the id type.
    const id = (await hashInput(input)) as Spec["id"];
    signal?.throwIfAborted();

    registry.acquire(id, input);
    try {
      // The cast bridges to `PartialConsumerRequest`, whose id/directives are
      // `ReadonlyDeep`-wrapped and so opaque against the plain types here while
      // `Spec` is generic — the same boundary coercion `wrapProducer` uses.
      const request = {
        id,
        ...(callOptions?.directives
          ? { directives: callOptions.directives }
          : {}),
      } as PartialConsumerRequest<Params, Spec["id"]>;

      return await wrapped(request, signal ? { signal } : undefined);
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
 * @param cache - Where produced values are stored.
 * @param options - See {@link WrapComputingProducerOptions}.
 * @param producer - Computes the values for the missed inputs on a cache miss.
 */
export function wrapBulkComputingProducer<
  Input,
  Spec extends CacheSpec,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  ErrorType extends Error = Error,
>(
  cache: PublicInterface<Cache<Spec, Validators, Params>>,
  options: WrapComputingProducerOptions<Input, Spec, Params>,
  producer: BulkComputingProducer<Input, Spec, Validators, Params, ErrorType>,
) {
  const { hashInput, isCacheable: isInputCacheable, ...wrapOptions } = options;
  const registry = new InputRegistry<Input>();

  // Each `registry.get` runs synchronously (while mapping) before `producer`
  // is invoked, so every input is read while still registered.
  const internalProducer: BulkProducer<Spec, Validators, Params, ErrorType> = (
    reqs,
    producerOptions,
  ) =>
    producer(
      reqs.map((req) => registry.get(req.id)),
      producerOptions,
    );

  const wrapped = wrapBulkProducer<Spec, Validators, Params, ErrorType>(
    cache,
    {
      ...wrapOptions,
      ...(isInputCacheable
        ? { isCacheable: (id: string) => isInputCacheable(registry.get(id)) }
        : {}),
    },
    internalProducer,
  );

  const wrappedBulkComputingProducer = async (
    inputs: readonly Input[],
    callOptions?: ComputingProducerCallOptions,
  ) => {
    const signal = callOptions?.signal;
    signal?.throwIfAborted();

    // See the single-producer variant for why the awaited hash is cast.
    const ids = (await Promise.all(
      // `Promise.resolve` since `hashInput` may be synchronous.
      inputs.map((input) => Promise.resolve(hashInput(input))),
    )) as Spec["id"][];
    signal?.throwIfAborted();

    ids.forEach((id, index) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- index-aligned with `ids`
      registry.acquire(id, inputs[index]!);
    });
    try {
      // See the single-producer variant for why the requests are cast.
      const requests = ids.map((id) => ({
        id,
        ...(callOptions?.directives
          ? { directives: callOptions.directives }
          : {}),
      })) as PartialConsumerRequest<Params, Spec["id"]>[];

      return await wrapped(requests, signal ? { signal } : undefined);
    } finally {
      ids.forEach((id) => registry.release(id));
    }
  };

  // Expose the cache on the returned function (for convenience, e.g. closing it).
  wrappedBulkComputingProducer.cache = cache;

  return wrappedBulkComputingProducer;
}
