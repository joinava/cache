import type { InvariantOf } from "type-fest";
import type { BatchOptions } from "../scheduling/batcher.js";
import type { CacheSpec } from "./00_CacheSpec.js";
import type { ResourceTypes, SpecOf } from "./00_ResourceTypes.js";
import type { AnyParams } from "./01_Params.js";
import type { AnyValidators } from "./02_Validators.js";
import type {
  NormalizeParamName,
  NormalizeParamValue,
} from "./06_Normalization.js";
import type { Store } from "./07_Store.js";
import type { Logger } from "./08_Logger.js";

/**
 * A backing store that supports `StoreSupportedTypes` and must cover
 * `RequiredSpec` -- the spec whose ids the cache will actually ask for.
 *
 * The store only has to support *at least* the cache's own resource types. That
 * matters because `Store` is invariant in its `Spec` -- `Spec` sits in both
 * `store()`/`delete()`'s parameters and `get()`/`getMany()`'s return types --
 * so a `Store<Wide>` is NOT assignable to a `Store<Narrow>` even though, for
 * any id the narrow cache actually asks for, the wide store returns exactly the
 * same thing. Rather than fight that variance, the store's own spec is captured
 * in `StoreSupportedTypes` and merely *checked* for coverage, so a
 * general-purpose store needs no artificially narrowed type arguments.
 *
 * The intersected guard is where coverage is enforced: TS has no lower-bound
 * constraint (`StoreSupportedTypes super RequiredSpec` is not expressible), so a
 * store that does NOT cover picks up an unsatisfiable requirement instead.
 * Inference still comes from the plain `Store<...>` member.
 *
 * Note: the Store interface should _already_ be invariant in its Params, but
 * TS's underlying handling of functions as always bivariant (which the compiler
 * tries to hide/override in some cases under strictFunctionTypes, but this
 * doesn't apply to class methods; see
 * https://www.typescriptlang.org/tsconfig/#strictFunctionTypes) means that we
 * have to use `InvariantOf<Params>` explicitly to get the type errors we want.
 */
type CoveringStore<
  RequiredSpec extends CacheSpec,
  StoreSupportedTypes extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
> = Store<StoreSupportedTypes, Validators, InvariantOf<Params>> &
  // The tuple brackets make this a whole-union comparison rather than a
  // distributive, member-by-member one. Without them, a `RequiredSpec` union
  // distributes and each covered member contributes `unknown`, which absorbs the
  // other members' requirements -- so a store covering ANY one resource type
  // would satisfy a registry of several.
  ([RequiredSpec] extends [StoreSupportedTypes]
    ? unknown
    : {
        readonly __storeMustSupportAtLeast: RequiredSpec;
      });

/**
 * Everything a `Cache` needs, as one bag. The store is a field rather
 * than a separate constructor argument because `options` has no useful default
 * (`name` and `resourceTypes` are both required), so there was never a call
 * shape where passing the store alone said anything.
 */
export type CacheOptions<
  RT extends ResourceTypes,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
  /**
   * The spec the STORE supports, which may be WIDER than this cache's own
   * `SpecOf<RT>` -- most stores are general-purpose. It is last and defaulted so
   * that `CacheOptions<RT, Validators, Params>` keeps meaning what it always
   * did; inserting it earlier silently shifts `Validators` into this slot at
   * every 3-argument use site.
   */
  StoreSupportedTypes extends CacheSpec = SpecOf<RT>,
> = {
  /**
   * REQUIRED. The backing store that will actually hold cache entries. It must
   * support at least this cache's own resource types, but may support more --
   * see {@link CoveringStore}.
   */
  store: CoveringStore<SpecOf<RT>, StoreSupportedTypes, Validators, Params>;
  /**
   * REQUIRED. Names this cache instance (≈ the backing table) in every
   * diagnostics message. Instance-unique per process by convention;
   * uniqueness is not enforced.
   */
  name: string;
  /**
   * REQUIRED. The cache's resource-type registry; see {@link ResourceTypes}.
   * Must partition the id space. For a cache with exactly one resource type,
   * `singleTypeCacheOptions` builds this (and names it) for you.
   */
  resourceTypes: RT;
  logger?: Logger;
  onGetAfterClose?: "throw" | "act-empty";
  onStoreAfterClose?: "throw" | "no-op";
  normalizeParamName?: NormalizeParamName<Params>;
  normalizeParamValue?: NormalizeParamValue<Params>;
  /**
   * Configure accumulation for bulk-capable Stores. The default limit is
   * 100 requests and applies only to accumulated
   * reads. Single-only Stores dispatch promptly. `getUnbatched` sends its set
   * as one Store call instead.
   */
  readBatching?: BatchOptions;
};
