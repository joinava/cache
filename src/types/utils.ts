import type { IsEqual, Simplify } from "type-fest";

export type { JSON } from "type-party";

export type Bind1<
  F extends (arg0: A0, ...args: never[]) => unknown,
  A0,
> = F extends (arg0: A0, ...args: infer Args) => infer R
  ? (...args: Args) => R
  : never;

export type Bind2<
  F extends (arg0: A0, arg1: A1, ...args: never[]) => unknown,
  A0,
  A1,
> = F extends (arg0: A0, arg1: A1, ...args: infer Args) => infer R
  ? (...args: Args) => R
  : never;

export type MakeKeysOptional<T extends object, K extends keyof T> = Simplify<
  Omit<T, K> & Partial<Pick<T, K>>
>;

/**
 * True iff `T` is a single type rather than a union.
 *
 * Implemented by distributing over `T` and checking each constituent against
 * the whole: a non-union `T` has its single constituent equal to itself, so
 * the distributed result is `true`; a union has each constituent strictly
 * narrower than the whole, so each comparison is `false`, and the union of
 * `false`s collapses to `false`.
 */
export type IsSingleType<T> = _IsSingleTypeImpl<T, T>;
type _IsSingleTypeImpl<Case, Union> = Case extends unknown
  ? IsEqual<Case, Union>
  : never;
