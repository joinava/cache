import type { Tagged } from "type-fest";
import type { Jsonify } from "type-party";
import type { CacheSpec, SpecForId } from "./00_CacheSpec.js";
import type { AnyParams, AnyParamValue } from "./01_Params.js";
import type { AnyValidators } from "./02_Validators.js";
import type { Vary } from "./04_ProducerResult.js";

/**
 * @fileoverview When the Cache asks the store to check for cached results that
 * match a request for a given resource, the store needs to be able to find any
 * results where the params were equivalent, even if not identical -- i.e., the
 * store needs to operate on the _normalized_ version of the params. However,
 * the rules for normalizing param keys and values vary system to system (e.g.,
 * param names/values may or may not be case sensitive) and the only sensible
 * place to apply this normalization is in the Cache itself.
 *
 * Therefore, the store should expect normalized params when it's asked to
 * lookup cached results, and should expect to be given an entry with a
 * normalized Vary when it's asked to store a new producer result. This file
 * defines the types for normalized params and normalized vary objects, which
 * can be used in that contract between the Cache and the store.
 *
 * Beyond that, we want to normalize other parts of the ProducerResult before
 * storing them, like setting default values for optional fields (`initialAge`,
 * `date`, etc) and normalizing certain directives. So, this file also defines
 * types for the normalized ProducerResult and ProducerResultResource objects.
 */

/**
 * Normalized Params will have no keys with undefined values, and will have all
 * param names + values run through the provided normalization functions.
 */
export type NormalizedParams<Params extends AnyParams> = Tagged<
  Params,
  "NormalizedParams"
>;

export type NormalizeParamName<Params extends AnyParams> = (
  it: string,
) => keyof Params;

export type NormalizeParamValue<Params extends AnyParams> = <
  K extends keyof Params,
>(
  paramName: K,
  rawValue: AnyParamValue,
) => Params[K] & AnyParamValue;

// The Vary object, after param names and values have been normalized.
export type NormalizedVary<Params extends AnyParams> = Tagged<
  Vary<Params>,
  "NormalizedVary"
>;

/**
 * Normalized producer maxStale object. All threshold fields are required and
 * guaranteed to be monotonically increasing:
 * `withoutRevalidation <= whileRevalidate <= ifError`.
 */
export type NormalizedProducerMaxStale = Tagged<
  {
    withoutRevalidation: number;
    whileRevalidate: number;
    ifError: number;
  },
  "NormalizedProducerMaxStale"
>;

/**
 * Normalized consumer maxStale object. All threshold fields are required and
 * guaranteed to be monotonically increasing:
 * `withoutRevalidation <= whileRevalidate <= ifError`.
 *
 * Also includes the optional `freshUntilAge` field that represents the
 * consumer's override of the producer's freshness determination.
 */
export type NormalizedConsumerMaxStale = Tagged<
  {
    freshUntilAge: number | undefined;
    withoutRevalidation: number;
    whileRevalidate: number;
    ifError: number;
  },
  "NormalizedConsumerMaxStale"
>;

export type NormalizedProducerResult<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = Spec extends unknown
  ? // Intersect _within_ the Spec distribution to help TS follow the difference between
    // this type and NormalizedProducerResultResource.
    _NormalizedProducerResultResource<
      Spec["id"],
      Spec["content"],
      Params,
      Validators
    > & {
      supplementalResources?:
        | NormalizedProducerResultResource<Spec, Validators, Params>[]
        | undefined;
    }
  : never;

/**
 * This represents the final shape of a producer's result for a resource, ready
 * to be stored in (or returned from) a Store or the Cache class.
 *
 * A normalized NormalizedProducerResultResource _must_ have the `vary` object
 * filled in with normalized! values.
 *
 * When `Spec` is a union, this distributes per-variant: each variant's `id`
 * is paired with its corresponding `content`.
 */
export type NormalizedProducerResultResource<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = Spec extends unknown
  ? _NormalizedProducerResultResource<
      Spec["id"],
      Spec["content"],
      Params,
      Validators
    >
  : never;

type _NormalizedProducerResultResource<
  Id extends string,
  Content extends unknown,
  Params extends AnyParams,
  Validators extends AnyValidators,
> = {
  id: Id;
  content: Content;
  vary: NormalizedVary<Params>;
  validators: Partial<Validators>;
  directives: NormalizedProducerDirectives;
  initialAge: number;
  date: Date;
};

/**
 * Entry is a synonym for NormalizedProducerResultResource. It's used throughout
 * for brevity, and is named with reference to the colloquial term "cache entry".
 */
export type Entry<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = NormalizedProducerResultResource<Spec, Validators, Params>;

export type JsonifiedEntry<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = Spec extends unknown
  ? Jsonify<
      _NormalizedProducerResultResource<
        Spec["id"],
        Spec["content"],
        Params,
        Validators
      >
    >
  : never;

/**
 * Convenience: an `Entry` narrowed to those spec variants whose id is
 * compatible with `RequestedId`.
 */
export type EntryForId<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
  RequestedId extends Spec["id"],
> = Entry<SpecForId<Spec, RequestedId>, Validators, Params>;

export type NormalizedProducerDirectives = Tagged<
  {
    freshUntilAge: number;
    maxStale?: NormalizedProducerMaxStale;
    storeFor?: number;
  },
  "NormalizedProducerDirectives"
>;
