import type { ReadonlyDeep } from "type-fest";
import type { CacheSpec } from "../types/00_CacheSpec.js";
import type {
  MultiIdTypeRequestPairedProducer,
  RequestPairedProducerResult,
} from "../types/05_RequestPairedProducer.js";
import type {
  AnyParams,
  AnyValidators,
  ConsumerRequest,
  RequestPairedProducer,
} from "../types/index.js";

/**
 * A single branch of a {@link producerByIdType} producer: pairs a runtime
 * type guard for a subset of the spec's ids with a handler whose return type
 * is narrowed to that subset's content.
 *
 * `NarrowedId` distributes over the spec's id types, so providing a guard
 * that only matches one variant gives a handler whose `req.id` is the
 * variant's id (literal or template-literal) and whose return type is
 * required to be content for *that* variant.
 */
export type ProducerBranch<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
  NarrowedId extends Spec["id"] = Spec["id"],
> = NarrowedId extends Spec["id"]
  ? {
      readonly matches: (id: Spec["id"]) => id is NarrowedId;
      readonly handle: (
        req: ReadonlyDeep<ConsumerRequest<Params, NarrowedId>>,
        options?: { signal?: AbortSignal },
      ) => Promise<
        RequestPairedProducerResult<Spec, Validators, Params, NarrowedId>
      >;
    }
  : never;

/**
 * The fluent builder returned by {@link producerByIdType}. Use `.when(...)`
 * to add per-id-type branches; each call infers its own `NarrowedId` from
 * the type guard, so the handler's `req.id` is concrete and TypeScript can
 * fully verify the (id, content) correlation in the body. End the chain
 * with `.build()` to produce the final {@link RequestPairedProducer}.
 *
 * The phantom `Covered` parameter accumulates the union of `NarrowedId`s
 * supplied to each `.when(...)` call so that `.build()` can statically
 * verify the chain is exhaustive for `Spec["id"]`. When the chain is
 * non-exhaustive, `.build()` returns a {@link _NonExhaustiveBuildError}
 * whose tuple shape names the missing ids and is not assignable to
 * `RequestPairedProducer`; the resulting error surfaces at the call site
 * that consumes the build result (typically `wrapProducer`).
 */
export type ProducerByIdTypeBuilder<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
  Covered extends Spec["id"] = never,
> = {
  readonly when: <NarrowedId extends Spec["id"]>(
    matches: (id: Spec["id"]) => id is NarrowedId,
    handle: (
      req: ReadonlyDeep<ConsumerRequest<Params, NarrowedId>>,
      options?: { signal?: AbortSignal },
    ) => Promise<
      RequestPairedProducerResult<Spec, Validators, Params, NarrowedId>
    >,
  ) => ProducerByIdTypeBuilder<
    Spec,
    Validators,
    Params,
    Covered | NarrowedId
  >;
  readonly build: () => _BuildResult<Spec, Validators, Params, Covered>;
};

/**
 * Error type produced by `.build()` when the builder hasn't covered every
 * id type in `Spec["id"]`. Surfaces as a TS error wherever the build result
 * is used (e.g., the `wrapProducer(...)` call site), naming the missing
 * ids in the message.
 */
type _NonExhaustiveBuildError<Missing> = readonly [
  "producerByIdType: builder is non-exhaustive; missing `.when(...)` branches for these ids:",
  Missing,
];

type _BuildResult<
  Spec extends CacheSpec,
  Validators extends AnyValidators,
  Params extends AnyParams,
  Covered extends Spec["id"],
> = [Exclude<Spec["id"], Covered>] extends [never]
  ? RequestPairedProducer<Spec, Validators, Params>
  : _NonExhaustiveBuildError<Exclude<Spec["id"], Covered>>;

/**
 * Builds a {@link RequestPairedProducer} for a multi-id-type cache from a
 * sequence of per-id-pattern branches.
 *
 * This is the recommended way to write per-id-typed producers. Each branch's
 * `handle` function is non-generic over `Id`, so the request's id is a
 * concrete (template-literal or branded) type and TypeScript can fully
 * verify the (id, content) correlation within its body. The unsafe
 * `Id`-bridging cast that a hand-written multi-id producer would require
 * lives once, inside this helper, and is justified by the type guards
 * provided to each `.when(...)`.
 *
 * Branches are tried in declaration order. If no branch matches a request's
 * id at runtime, the returned producer rejects with a descriptive error.
 * (Use exhaustive specs and matching guards to avoid this in production
 * code paths.)
 *
 * @example
 *   type StoriesSpec =
 *     | CacheSpec<`story:${string}`, Story>
 *     | CacheSpec<`collection:${string}`, Story[]>;
 *
 *   const fetcher = wrapProducer<StoriesSpec>(cache, options,
 *     producerByIdType<StoriesSpec>()
 *       .when(idStartsWith("story:"), async (req) => ({
 *         // req.id: `story:${string}`  ⇒  content must be Story
 *         content: { id: req.id, title: `Story ${req.id}` },
 *         directives: { freshUntilAge: 1 },
 *       }))
 *       .when(idStartsWith("collection:"), async (req) => ({
 *         // req.id: `collection:${string}`  ⇒  content must be Story[]
 *         content: [{ id: "1", title: "a" }],
 *         directives: { freshUntilAge: 1 },
 *       }))
 *       .build(),
 *   );
 */
export function producerByIdType<
  Spec extends CacheSpec,
  Validators extends AnyValidators = AnyValidators,
  Params extends AnyParams = AnyParams,
>(): ProducerByIdTypeBuilder<Spec, Validators, Params> {
  // Internal mutable list of accumulated branches. We only ever append, so
  // each `.when(...)` returns a builder backed by the same list.
  // `NarrowedId` is erased here (`Spec["id"]` is the safe upper bound) --
  // it's already been verified at each `.when(...)` call.
  const branches: ProducerBranch<Spec, Validators, Params>[] = [];

  // The runtime builder is a single object shared across all chained
  // `.when(...)` calls. The exhaustiveness tracking lives entirely in the
  // type system (the phantom `Covered` parameter on the public type), so
  // we cast once at the bottom to surface that to TS while keeping a
  // single value at runtime.
  const builder = {
    when(
      matches: ProducerBranch<Spec, Validators, Params>["matches"],
      handle: ProducerBranch<Spec, Validators, Params>["handle"],
    ) {
      branches.push({ matches, handle } as unknown as ProducerBranch<
        Spec,
        Validators,
        Params
      >);
      return builder;
    },

    build() {
      const dispatch: MultiIdTypeRequestPairedProducer<
        Spec,
        Validators,
        Params
      > = async <Id extends Spec["id"]>(
        req: ReadonlyDeep<ConsumerRequest<Params, Id>>,
        options?: { signal?: AbortSignal },
      ) => {
        for (const branch of branches) {
          if (branch.matches(req.id)) {
            // SAFETY: the guard above just confirmed `req.id` is in
            // `branch`'s `NarrowedId`, so `req` is a valid argument to
            // `branch.handle` and the result's (id, content) correlation
            // is valid for the actual call's effective `Id`.
            return (await branch.handle(
              req as unknown as ReadonlyDeep<
                ConsumerRequest<Params, Spec["id"]>
              >,
              options,
            )) as RequestPairedProducerResult<Spec, Validators, Params, Id>;
          }
        }
        throw new Error(
          `producerByIdType: no branch matched request id ${JSON.stringify(req.id)}`,
        );
      };

      // The declared return type of `.build()` is `_BuildResult`, which
      // resolves to either a `RequestPairedProducer` (when the chain is
      // exhaustive) or a `_NonExhaustiveBuildError` tuple (when it isn't).
      // The runtime value is always a producer; in the non-exhaustive case
      // the user gets a TS error at the consuming call site (typically
      // `wrapProducer`) with the missing ids spelled out in the type.
      return dispatch as unknown as _BuildResult<
        Spec,
        Validators,
        Params,
        never
      >;
    },
  };

  return builder as unknown as ProducerByIdTypeBuilder<
    Spec,
    Validators,
    Params
  >;
}

/**
 * Type guard helper: matches ids whose runtime value starts with a prefix.
 * Useful with template-literal-keyed specs (e.g., `\`story:${string}\``)
 * when used with {@link producerByIdType}.
 *
 * The returned guard is generic in the input id, so passing it to a
 * `producerByIdType` branch correctly narrows the spec's id union down to
 * its `${Prefix}${string}` constituents.
 */
export function idStartsWith<Prefix extends string>(
  prefix: Prefix,
): <Id extends string>(id: Id) => id is Extract<Id, `${Prefix}${string}`> {
  return ((id: string) => id.startsWith(prefix)) as <Id extends string>(
    id: Id,
  ) => id is Extract<Id, `${Prefix}${string}`>;
}
