import {
  hashedInputProducerByInputType,
  bulkHashedInputProducerByInputType,
  wrapHashedInputProducer,
  type HashedInputVariant,
  producerByIdType,
  wrapProducer,
  Cache,
  MemoryStore,
  naiveGetMany,
  throwIfAnyError,
  resourceType,
  type SpecOf,
  type Store,
} from "@zingage/cache";
import type { IsEqual } from "type-fest";

const registry = {
  user: resourceType<{ name: string }>()({
    matches: (id): id is `user:${string}` => id.startsWith("user:"),
  }),
  count: resourceType<number>()({
    matches: (id): id is `count:${string}` => id.startsWith("count:"),
  }),
};
const memory = new MemoryStore<SpecOf<typeof registry>, {}, {}>();
const cache = new Cache({
  name: "consumer-fixture",
  store: memory,
  resourceTypes: registry,
});
const cached = throwIfAnyError(
  await cache.getMany([
    { id: "user:a", params: {}, directives: {} },
    { id: "count:a", params: {}, directives: {} },
  ] as const),
);
const cachedType: IsEqual<
  NonNullable<(typeof cached)[0]["usable"]>["content"],
  { name: string }
> = true;
const cachedSecondType: IsEqual<
  NonNullable<(typeof cached)[1]["usable"]>["content"],
  number
> = true;
void [cachedType, cachedSecondType];

const methods = {
  store: memory.store.bind(memory),
  delete: memory.delete.bind(memory),
  close: memory.close.bind(memory),
  [Symbol.asyncDispose]: memory[Symbol.asyncDispose].bind(memory),
};
// @ts-expect-error A Store cannot declare both read primitives.
const both: Store<SpecOf<typeof registry>, {}, {}> = {
  ...methods,
  get: memory.get.bind(memory),
  getMany: async (requests) => await naiveGetMany(memory, requests),
};
// @ts-expect-error A Store must declare one read primitive.
const neither: Store<SpecOf<typeof registry>, {}, {}> = methods;
void cache.get(
  { id: "count:a", params: {}, directives: {} },
  // @ts-expect-error Explicit true is not a supported participation override.
  { autoBatch: true },
);
new Cache({
  name: "invalid",
  store: memory,
  resourceTypes: registry,
  // @ts-expect-error Construction cannot disable capability-driven defaults.
  readBatching: false,
});
void [both, neither];

const client = wrapProducer({
  cache,
  produce: producerByIdType(registry, {
    user: async ({ id }) => ({
      content: { name: id },
      directives: { freshUntilAge: 60 },
    }),
    count: async () => ({ content: 1, directives: { freshUntilAge: 60 } }),
  }),
});
const wrapped = throwIfAnyError(
  await client.getMany([{ id: "user:a" }, { id: "count:a" }] as const),
);
const wrappedFirst: IsEqual<(typeof wrapped)[0]["content"], { name: string }> =
  true;
const wrappedSecond: IsEqual<(typeof wrapped)[1]["content"], number> = true;
// @ts-expect-error A wrapper requires one producer capability.
wrapProducer({ cache });
const bothProducerCapabilities = {
  cache,
  produce: async () => ({ content: 1, directives: { freshUntilAge: 60 } }),
  produceMany: async () => [],
};
// @ts-expect-error A wrapper cannot declare both producer capabilities.
wrapProducer(bothProducerCapabilities);
// @ts-expect-error Explicit true cannot enable producer accumulation.
void client.get({ id: "count:a" }, { autoBatch: { producer: true } });
void [wrappedFirst, wrappedSecond];

type UserInput = { kind: "user"; name: string };
type CountInput = { kind: "count"; value: number };
type Variants = {
  user: HashedInputVariant<UserInput, { name: string }>;
  count: HashedInputVariant<CountInput, number>;
};
const descriptor = hashedInputProducerByInputType<Variants>()
  .when((input): input is UserInput => input.kind === "user", {
    name: "user",
    hashInput: (input) => `user:${input.name}` as const,
    produce: async (input) => ({
      content: { name: input.name },
      directives: { freshUntilAge: 60 },
    }),
  })
  .when((input): input is CountInput => input.kind === "count", {
    name: "count",
    hashInput: (input) => `count:${input.value}` as const,
    produce: async (input) => ({
      content: input.value,
      directives: { freshUntilAge: 60 },
    }),
  })
  .build();
const hashed = wrapHashedInputProducer({ cache, produce: descriptor });
const hashedResults = throwIfAnyError(
  await hashed.getMany([
    { kind: "user", name: "a" },
    { kind: "count", value: 1 },
  ] as const),
);
const hashedFirst: IsEqual<
  (typeof hashedResults)[0]["content"],
  { name: string }
> = true;
const hashedSecond: IsEqual<(typeof hashedResults)[1]["content"], number> =
  true;
const conflictingHashOptions = {
  cache,
  produce: descriptor,
  hashInput: (_input: unknown) => "user:a" as const,
};
// @ts-expect-error Descriptors already own hashing; a separate hash conflicts.
wrapHashedInputProducer(conflictingHashOptions);
// @ts-expect-error A single descriptor cannot declare bulk capability.
wrapHashedInputProducer({ cache, produceMany: descriptor });
const bulkDescriptor = bulkHashedInputProducerByInputType<Variants>()
  .when((input): input is UserInput => input.kind === "user", {
    name: "user",
    hashInput: (input) => `user:${input.name}` as const,
    produce: async (inputs) =>
      inputs.map((input) => ({
        content: { name: input.name },
        directives: { freshUntilAge: 60 },
      })),
  })
  .build();
// @ts-expect-error A bulk descriptor cannot declare single capability.
wrapHashedInputProducer({ cache, produce: bulkDescriptor });
void [hashedFirst, hashedSecond];
