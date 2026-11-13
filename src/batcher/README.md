# Batcher

`Batcher` collects units of work and sends them to one `dispatch` function in
batches. It replaces [DataLoader](https://github.com/graphql/dataloader) in
this library. `Cache` uses it directly for Store reads.
`BulkProducerScheduler` uses it, together with `TaskSharer`, for bulk producer
calls. A single producer has nothing to batch, so it uses no batcher.

The batcher is internal (`@internal`). The package does not export it.

## Same as DataLoader

When no signal aborts and nobody calls `flush`, `close` or `dispatchNow`, a
`Batcher` behaves like a DataLoader built with `cache: false`:

- `enqueue` corresponds to `load`, or to `loadMany` for several items.
- A batch opens with its first entry and schedules its own dispatch.
- The default schedule is DataLoader's. The batch dispatches in a
  `process.nextTick` that a resolved promise queues. So the batch takes every
  entry from the current event-loop turn and from the promise jobs that the
  turn queues.
- `batchScheduleFn` replaces the default schedule, as in DataLoader. It
  receives the batch's dispatch callback.
- A batch takes entries until it holds `maxBatchSize` of them. The next entry
  opens a new batch, with its own scheduled dispatch. A full batch does not
  dispatch early.
- `dispatch` returns a promise of one result per item, in order. An `Error`
  in a result slot rejects only that item. A rejection, or a synchronous
  throw, rejects every item in the batch with the same error.
- A repeated input is sent again. The batcher never shares work between
  items. `TaskSharer` does that.

[`batcher.dataloader.test.ts`](./batcher.dataloader.test.ts) holds
DataLoader's own tests, ported to the batcher. The file header lists the
tests that it leaves out, and why.

## Added to DataLoader

- **Cancellation.** An item can carry an `AbortSignal`. When the signal
  aborts while the item waits in a batch, the item leaves the batch and its
  result rejects with the signal's reason. The item also frees its slot, so
  that a later entry can join the batch. An item whose signal already
  aborted is rejected at once and never queued. Work that has dispatched
  always completes.
- **`dispatchNow`.** It sends new items at once, without a batch. It can also
  pull queued entries forward: the caller passes the handles that `enqueue`
  returned, including handles from other callers. One `dispatchNow` call is
  one `dispatch` call, which `maxBatchSize` never splits.
- **`flush`.** It dispatches every pending batch now. It also drops
  `batchScheduleFn`, so later batches use the default schedule. An owner
  calls it when its shutdown starts, because its own schedule may stop
  firing then.
- **`close`.** It flushes, then resolves once no batch is pending and no
  dispatch is running. It waits for work that a dispatch enqueues into the
  same batcher. After `close`, `enqueue` and `dispatchNow` log a warning, but
  the work still runs.
- **Dispatch facts.** `dispatch` receives each item's queue wait in
  milliseconds, and an `autoBatched` flag that says whether a batch or
  `dispatchNow` sent the call.
- **`preserveAsyncContext`.** When it is on, each batch dispatches in the
  async context of the `enqueue` call that opened the batch. Use it when
  `batchScheduleFn` runs its callbacks from an unrelated context, or when
  `flush` must not run a batch in the closer's context.

## Not in the Batcher

- **No cache.** The batcher has no `clear`, `clearAll`, `prime`,
  `cacheKeyFn` or `cacheMap`. `Cache` and `TaskSharer` own caching and work
  sharing.
- **No `name` and no `batch: false`.** Use `maxBatchSize: 1` to send each item
  alone.

## Known differences from DataLoader

These differences remain on purpose. No test covers them.

| Behavior                                                                               | DataLoader                                                         | Batcher                                                                              |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Default `maxBatchSize`                                                                 | No limit                                                           | 20 (`DEFAULT_PRODUCER_BATCH_SIZE`). `Cache` passes a larger default for Store reads. |
| A `maxBatchSize` that is not an integer, such as `1.5`                                 | Accepted                                                           | Throws a `TypeError`                                                                 |
| `dispatch` throws or rejects with a value that is not an `Error`                       | Rejects each load with that value                                  | Rejects each item with an `Error` whose `cause` is that value                        |
| `dispatch` throws synchronously, or resolves with a value of the wrong shape or length | Rejects each load with DataLoader's own `TypeError` message        | Rejects each item with the original error, or with a `CacheContractError`            |
| When results settle                                                                    | One microtask after the `dispatch` promise resolves                | About two microtasks later, because `Promise.try` adopts the `dispatch` promise      |
| `batchScheduleFn` runs its callback synchronously                                      | Strands the entry in a dispatched batch, so its load never settles | Schedules a call's batches only after all of the call's entries are in place         |
