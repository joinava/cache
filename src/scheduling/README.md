# Scheduling

This folder holds the parts that decide when work runs, which callers share it,
and when an owner can close. None of them knows about caches, Stores or
producers. Their owners supply that knowledge through callbacks.

| Module                                                  | What it does                                                             | Who uses it                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| [`Batcher`](./batcher.ts)                               | Collects items and sends them to one `dispatch` function in batches.     | `Cache`, for Store reads. `BulkProducerScheduler`, for bulk producer calls. |
| [`TaskSharer`](./taskSharer.ts)                         | Lets requests with the same key share one pending task.                  | Both producer schedulers. `collapsedTaskCreator`.                           |
| [`collapsedTaskCreator`](./collapsedTaskCreator.ts)     | Wraps a task-starting function so that equal calls share a pending task. | Package users. It is the only public export here.                           |
| [`PendingPromisesTracker`](./pendingPromisesTracker.ts) | Tracks promises until they settle, so that `close` can wait for them.    | `Cache`, `Batcher`, `SqliteStore`, and the producer wrappers.               |

The pieces compose like this:

- A single producer uses a `TaskSharer` and sends each task at once. It has
  nothing to batch.
- A bulk producer uses a `TaskSharer` in front of a `Batcher`. The sharer
  decides which requests start new tasks. The batcher groups the new tasks
  into producer calls.
- `Cache` uses a `Batcher` alone. It does not share Store reads between
  requests.

Everything except `collapsedTaskCreator` is internal (`@internal`). The
package does not export it.

## TaskSharer

A `TaskSharer` takes a batch of task requests in one `startOrRideTasks` call.
Each task request is an input plus an optional `AbortSignal`. For each one,
the sharer either starts a new task or rides a pending task with the same key.

- `makeKey` derives each input's key. A key of `undefined` means the input
  never shares work.
- A task request rides a pending task only if the task started no more than
  `collapseTasksMs` ago, has not settled, and is not cancelled.
- The tasks that one call starts go to the owner's `schedule` callback in one
  call. So a bulk caller's new inputs become one unit of work.
- Each task has its own signal. It aborts only when every request on the task
  is cancelled. A request without a signal can never be cancelled, so it keeps
  the task alive.
- The sharer counts the requests that ride each task, for diagnostics.
- `drain` waits until every task has settled, including tasks started while it
  waits.

The sharer does not queue, batch, or limit work. The `schedule` callback owns
that.

## collapsedTaskCreator

`collapsedTaskCreator` wraps a function that starts a task and returns a
promise. A later call with the same arguments gets the pending task's promise
instead of a new task, but only while the task still runs and only within
`collapseTasksMs` of its start. It is a mix of memoizing, throttling, and
promise sharing. It runs on `TaskSharer`, with one task request per call.

## PendingPromisesTracker

An owner tracks each piece of accepted work, then drains the tracker in its
`close`.

- `track(promise)` tracks a promise until it settles. Tracking never creates
  an unhandled rejection.
- `run(start)` tracks before it calls `start`, and turns a synchronous throw
  into a rejection.
- `drain()` waits until no tracked promise is pending, including promises
  tracked while it waits.

The tracker has no closed state. Each owner decides what happens to work that
arrives after its `close` starts, and in what order it drains its trackers.

## Batcher

`Batcher` collects units of work and sends them to one `dispatch` function in
batches. It replaces [DataLoader](https://github.com/graphql/dataloader) in
this library.

### Same as DataLoader

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

### Added to DataLoader

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

### Not in the Batcher

- **No cache.** The batcher has no `clear`, `clearAll`, `prime`,
  `cacheKeyFn` or `cacheMap`. `Cache` and `TaskSharer` own caching and work
  sharing.
- **No `name` and no `batch: false`.** Use `maxBatchSize: 1` to send each item
  alone.

### Known differences from DataLoader

These differences remain on purpose. No test covers them.

| Behavior                                                                               | DataLoader                                                         | Batcher                                                                              |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Default `maxBatchSize`                                                                 | No limit                                                           | 20 (`DEFAULT_PRODUCER_BATCH_SIZE`). `Cache` passes a larger default for Store reads. |
| A `maxBatchSize` that is not an integer, such as `1.5`                                 | Accepted                                                           | Throws a `TypeError`                                                                 |
| `dispatch` throws or rejects with a value that is not an `Error`                       | Rejects each load with that value                                  | Rejects each item with an `Error` whose `cause` is that value                        |
| `dispatch` throws synchronously, or resolves with a value of the wrong shape or length | Rejects each load with DataLoader's own `TypeError` message        | Rejects each item with the original error, or with a `CacheContractError`            |
| When results settle                                                                    | One microtask after the `dispatch` promise resolves                | About two microtasks later, because `Promise.try` adopts the `dispatch` promise      |
| `batchScheduleFn` runs its callback synchronously                                      | Strands the entry in a dispatched batch, so its load never settles | Schedules a call's batches only after all of the call's entries are in place         |
