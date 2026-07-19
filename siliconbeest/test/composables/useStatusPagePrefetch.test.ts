import { defineComponent, h } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiResponse } from '@/api/client'
import {
  refreshAffectedStatusPagePrefetches,
  resetStatusPagePrefetches,
  type StatusPageRequest,
  useStatusPagePrefetch,
} from '@/composables/useStatusPagePrefetch'
import type { Status } from '@/types/mastodon'

function makeStatus(id: string, accountId = 'account-1'): Status {
  return {
    id,
    account: { id: accountId },
    reblog: null,
  } as Status
}

function makePage(...statuses: Status[]): ApiResponse<Status[]> {
  return { data: statuses, headers: new Headers() }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const wrappers: VueWrapper[] = []

function mountPrefetch(visibleStatuses: Status[] = []) {
  let prefetch!: ReturnType<typeof useStatusPagePrefetch>
  const wrapper = mount(defineComponent({
    setup() {
      prefetch = useStatusPagePrefetch({
        feedKey: () => 'test-feed',
        visibleStatuses: () => visibleStatuses,
      })
      return () => h('div')
    },
  }))
  wrappers.push(wrapper)
  return prefetch
}

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()!.unmount()
})

describe('useStatusPagePrefetch', () => {
  it('starts one page ahead and reuses that raw response on consume', async () => {
    const response = makePage(makeStatus('next'))
    const request: StatusPageRequest = vi.fn().mockResolvedValue(response)
    const prefetch = mountPrefetch()

    prefetch.prefetch('cursor-1', request)
    expect(request).toHaveBeenCalledOnce()

    await expect(prefetch.consume('cursor-1', request)).resolves.toBe(response)
    expect(request).toHaveBeenCalledOnce()
  })

  it('performs a normal retry when the background request failed', async () => {
    const response = makePage(makeStatus('retried'))
    const request: StatusPageRequest = vi.fn()
      .mockRejectedValueOnce(new Error('background failed'))
      .mockResolvedValueOnce(response)
    const prefetch = mountPrefetch()

    prefetch.prefetch('cursor-1', request)

    await expect(prefetch.consume('cursor-1', request)).resolves.toBe(response)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('does not return a response from a reset feed generation', async () => {
    const pending = deferred<ApiResponse<Status[]>>()
    const request: StatusPageRequest = vi.fn(() => pending.promise)
    const prefetch = mountPrefetch()

    prefetch.prefetch('cursor-1', request)
    const consuming = prefetch.consume('cursor-1', request)
    prefetch.reset()
    pending.resolve(makePage(makeStatus('stale')))

    await expect(consuming).resolves.toBeUndefined()
  })

  it('aborts account-scoped raw responses when all mounted feeds reset', () => {
    const pending = deferred<ApiResponse<Status[]>>()
    let requestSignal: AbortSignal | undefined
    const request: StatusPageRequest = vi.fn((signal) => {
      requestSignal = signal
      return pending.promise
    })
    const prefetch = mountPrefetch()

    prefetch.prefetch('cursor-1', request)
    expect(prefetch.isCurrent(0)).toBe(true)

    resetStatusPagePrefetches()

    expect(requestSignal?.aborted).toBe(true)
    expect(prefetch.isCurrent(0)).toBe(false)
  })

  it('coalesces repeated mutations when the visible feed is affected', async () => {
    const visible = [makeStatus('visible')]
    const request: StatusPageRequest = vi.fn().mockResolvedValue(makePage(makeStatus('next')))
    const prefetch = mountPrefetch(visible)
    prefetch.prefetch('cursor-1', request)

    const predicate = (status: Status) => status.id === 'visible'
    refreshAffectedStatusPagePrefetches(predicate)
    refreshAffectedStatusPagePrefetches(predicate)
    await Promise.resolve()

    expect(request).toHaveBeenCalledTimes(2)
  })

  it('refreshes only when a completed raw page contains the mutation target', async () => {
    const affectedRequest: StatusPageRequest = vi.fn()
      .mockResolvedValue(makePage(makeStatus('affected')))
    const unaffectedRequest: StatusPageRequest = vi.fn()
      .mockResolvedValue(makePage(makeStatus('other')))
    const affected = mountPrefetch()
    const unaffected = mountPrefetch()
    affected.prefetch('affected-cursor', affectedRequest)
    unaffected.prefetch('unaffected-cursor', unaffectedRequest)
    await Promise.resolve()

    refreshAffectedStatusPagePrefetches(status => status.id === 'affected')
    await Promise.resolve()
    await Promise.resolve()

    expect(affectedRequest).toHaveBeenCalledTimes(2)
    expect(unaffectedRequest).toHaveBeenCalledOnce()
  })
})
