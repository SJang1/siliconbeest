import { onScopeDispose } from 'vue'
import type { ApiResponse } from '@/api/client'
import type { Status } from '@/types/mastodon'

export type StatusPageRequest = (
  signal: AbortSignal,
) => Promise<ApiResponse<Status[]>>

export type StatusPrefetchPredicate = (status: Status) => boolean

type PrefetchResult =
  | { ok: true; response: ApiResponse<Status[]> }
  | { ok: false; error: unknown }

interface PrefetchEntry {
  cursor: string
  generation: number
  request: StatusPageRequest
  controller: AbortController
  invalidators: StatusPrefetchPredicate[]
  refreshAfterSettle: boolean
  promise: Promise<PrefetchResult>
}

interface RegisteredPrefetch {
  feedKey: () => string
  reset: () => void
  refreshAffected: (
    predicate: StatusPrefetchPredicate,
    force: boolean,
  ) => void
  visibleStatuses: () => readonly Status[]
}

const registeredPrefetches = new Set<RegisteredPrefetch>()

/**
 * Refresh only mounted secondary feeds whose visible or prefetched page is
 * affected by a status mutation. `forceFeedKeys` is available for callers
 * that already know which feed was affected without inspecting visible data.
 */
export function refreshAffectedStatusPagePrefetches(
  predicate: StatusPrefetchPredicate,
  forceFeedKeys: ReadonlySet<string> = new Set(),
) {
  for (const registered of registeredPrefetches) {
    const force = forceFeedKeys.has(registered.feedKey())
      || registered.visibleStatuses().some(predicate)
    registered.refreshAffected(predicate, force)
  }
}

/** Drop every mounted secondary feed's account-scoped raw response. */
export function resetStatusPagePrefetches() {
  for (const registered of registeredPrefetches) registered.reset()
}

/**
 * Holds exactly one raw API page ahead of a mounted status feed. Responses are
 * not exposed to Vue or status caches until `consume()` is called.
 */
export function useStatusPagePrefetch(options: {
  feedKey: () => string
  visibleStatuses?: () => readonly Status[]
}) {
  let generation = 0
  let entry: PrefetchEntry | undefined
  let queuedRestart: PrefetchEntry | undefined
  let restartQueued = false

  function discard(abort: boolean) {
    const current = entry
    entry = undefined
    if (abort) current?.controller.abort()
  }

  function start(
    cursor: string,
    request: StatusPageRequest,
    expectedGeneration: number,
  ): PrefetchEntry | undefined {
    if (expectedGeneration !== generation) return undefined

    if (
      entry
      && entry.cursor === cursor
      && entry.generation === expectedGeneration
    ) {
      return entry
    }

    discard(true)
    const controller = new AbortController()
    const nextEntry: PrefetchEntry = {
      cursor,
      generation: expectedGeneration,
      request,
      controller,
      invalidators: [],
      refreshAfterSettle: false,
      promise: request(controller.signal).then(
        (response): PrefetchResult => ({ ok: true, response }),
        (error): PrefetchResult => ({ ok: false, error }),
      ),
    }
    entry = nextEntry
    return nextEntry
  }

  function restart(expected: PrefetchEntry) {
    if (entry !== expected || expected.generation !== generation) return
    const { cursor, request, generation: expectedGeneration } = expected
    discard(true)
    start(cursor, request, expectedGeneration)
  }

  function queueRestart(expected: PrefetchEntry) {
    queuedRestart = expected
    if (restartQueued) return
    restartQueued = true
    queueMicrotask(() => {
      restartQueued = false
      const current = queuedRestart
      queuedRestart = undefined
      if (current) restart(current)
    })
  }

  function responseNeedsRefresh(
    current: PrefetchEntry,
    statuses: readonly Status[],
  ) {
    return current.invalidators.some((predicate) => statuses.some(predicate))
  }

  function refreshAffected(
    predicate: StatusPrefetchPredicate,
    force: boolean,
  ) {
    const current = entry
    if (!current) return
    current.invalidators.push(predicate)

    if (force) {
      current.refreshAfterSettle = true
      queueRestart(current)
      return
    }

    void current.promise.then((result) => {
      if (
        result.ok
        && entry === current
        && responseNeedsRefresh(current, result.response.data)
      ) {
        queueRestart(current)
      }
    })
  }

  const registered: RegisteredPrefetch = {
    feedKey: options.feedKey,
    reset: () => reset(),
    visibleStatuses: options.visibleStatuses ?? (() => []),
    refreshAffected,
  }
  // Nuxt runs setup during SSR. Never retain request-scoped callbacks in a
  // module-level registry shared by subsequent server requests.
  const registeredOnClient = typeof window !== 'undefined'
  if (registeredOnClient) registeredPrefetches.add(registered)

  onScopeDispose(() => {
    if (registeredOnClient) registeredPrefetches.delete(registered)
    generation += 1
    queuedRestart = undefined
    discard(true)
  })

  function reset(): number {
    generation += 1
    queuedRestart = undefined
    discard(true)
    return generation
  }

  function isCurrent(expectedGeneration: number): boolean {
    return expectedGeneration === generation
  }

  function prefetch(
    cursor: string | undefined | null,
    request: StatusPageRequest,
    expectedGeneration = generation,
  ) {
    if (!cursor || expectedGeneration !== generation) return
    start(cursor, request, expectedGeneration)
  }

  async function consumeEntry(
    cursor: string,
    request: StatusPageRequest,
    expectedGeneration: number,
    retryAfterPrefetchFailure: boolean,
  ): Promise<ApiResponse<Status[]> | undefined> {
    if (expectedGeneration !== generation) return undefined
    const current = start(cursor, request, expectedGeneration)
    if (!current) return undefined

    const result = await current.promise
    if (expectedGeneration !== generation) return undefined

    if (entry !== current) {
      return consumeEntry(
        cursor,
        request,
        expectedGeneration,
        retryAfterPrefetchFailure,
      )
    }

    if (!result.ok) {
      discard(false)
      if (retryAfterPrefetchFailure) {
        return consumeEntry(cursor, request, expectedGeneration, false)
      }
      throw result.error
    }

    if (
      current.refreshAfterSettle
      || responseNeedsRefresh(current, result.response.data)
    ) {
      restart(current)
      return consumeEntry(
        cursor,
        request,
        expectedGeneration,
        retryAfterPrefetchFailure,
      )
    }

    discard(false)
    return result.response
  }

  function consume(
    cursor: string,
    request: StatusPageRequest,
    expectedGeneration = generation,
  ): Promise<ApiResponse<Status[]> | undefined> {
    return consumeEntry(cursor, request, expectedGeneration, true)
  }

  return {
    consume,
    isCurrent,
    prefetch,
    reset,
  }
}
