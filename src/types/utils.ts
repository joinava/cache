import type { Simplify } from "type-fest";

/**
 * JSON-serializable values.
 */
export type JSON =
  | null
  | string
  | boolean
  | number
  | JSON[]
  | { [k: string]: JSON }
  | { [key in string]?: JSON };

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
