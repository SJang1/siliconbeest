import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useTimelinesStore } from '@/stores/timelines';
import { useNotificationsStore } from '@/stores/notifications';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function credentialResponse(id: string) {
  return new Response(JSON.stringify({ id, username: id }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Auth Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.removeItem("siliconbeest_token"); localStorage.removeItem("siliconbeest_theme");
    document.cookie = 'siliconbeest_token=; Path=/; Max-Age=0';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    vi.clearAllMocks();
  });

  it('initializes with no user', () => {
    const store = useAuthStore();
    expect(store.isAuthenticated).toBe(false);
    expect(store.currentUser).toBeNull();
    expect(store.token).toBeNull();
  });

  it('persists token to cookie', () => {
    const store = useAuthStore();
    store.setToken('test-token-123');
    expect(document.cookie).toContain('siliconbeest_token=test-token-123');
  });

  it('resets per-account state only when setToken changes the token', () => {
    const store = useAuthStore();
    const ui = useUiStore();
    const timelines = useTimelinesStore();
    store.setToken('first-token');
    store.currentUser = { id: 'first-user', username: 'first-user' } as any;
    ui.hydrateFromServer('first-token', {
      'ui:columns': '["home"]',
      'ui:show_trending': null,
    });
    const firstAccountTimeline = timelines.getTimeline('recommended');
    firstAccountTimeline.statusIds = ['first-account-private'];
    firstAccountTimeline.nextPage = '/api/v1/timelines/recommended?cursor=first-account';

    store.setToken('first-token');
    expect(store.currentUser?.id).toBe('first-user');
    expect(ui.columns).toEqual(['home']);
    expect(firstAccountTimeline.statusIds).toEqual(['first-account-private']);
    expect(firstAccountTimeline.nextPage).toContain('first-account');

    store.setToken('second-token');
    expect(store.currentUser).toBeNull();
    expect(ui.columns).toEqual([]);
    expect(ui.serverLoaded).toBe(false);
    expect(firstAccountTimeline.statusIds).toEqual([]);
    expect(firstAccountTimeline.nextPage).toBeUndefined();
    expect(timelines.timelines.size).toBe(0);
  });

  it('resets timelines and notifications when the token changes', () => {
    const store = useAuthStore();
    const timelines = useTimelinesStore();
    const notifications = useNotificationsStore();
    const resetTimelines = vi.spyOn(timelines, 'reset');
    const resetNotifications = vi.spyOn(notifications, 'reset');

    store.setToken('first-token');
    resetTimelines.mockClear();
    resetNotifications.mockClear();

    store.setToken('second-token');

    expect(resetTimelines).toHaveBeenCalledOnce();
    expect(resetNotifications).toHaveBeenCalledOnce();
  });

  it('leaves timeline stream startup to mounted views', async () => {
    const store = useAuthStore();
    const timelines = useTimelinesStore();
    const notifications = useNotificationsStore();
    const connectTimeline = vi
      .spyOn(timelines, 'connectStream')
      .mockImplementation(() => {});
    const connectNotifications = vi
      .spyOn(notifications, 'connectStream')
      .mockImplementation(() => {});

    store.setToken('test-token');
    await store.fetchCurrentUser();

    expect(connectTimeline).not.toHaveBeenCalled();
    expect(connectNotifications).toHaveBeenCalledWith('test-token');
  });

  it('waits for server UI preferences before resolving the current-user request', async () => {
    const preferenceLoad = deferred<void>();
    const store = useAuthStore();
    const ui = useUiStore();
    const loadFromServer = vi.spyOn(ui, 'loadFromServer')
      .mockReturnValueOnce(preferenceLoad.promise);
    store.setToken('test-token');

    let resolved = false;
    const currentUserRequest = store.fetchCurrentUser().then(() => {
      resolved = true;
    });
    await vi.waitFor(() => expect(loadFromServer).toHaveBeenCalledWith('test-token'));
    expect(resolved).toBe(false);

    preferenceLoad.resolve();
    await currentUserRequest;
    expect(resolved).toBe(true);
  });

  it('resets per-account state when the cookie token changes or disappears', () => {
    const store = useAuthStore();
    const ui = useUiStore();
    const timelines = useTimelinesStore();
    store.setToken('first-token');
    ui.hydrateFromServer('first-token', {
      'ui:columns': '["local"]',
      'ui:show_trending': null,
    });
    const firstTimeline = timelines.getTimeline('recommended');
    firstTimeline.nextPage = '/api/v1/timelines/recommended?cursor=first';

    store.syncTokenFromCookie('first-token');
    expect(ui.columns).toEqual(['local']);
    expect(firstTimeline.nextPage).toContain('first');

    store.syncTokenFromCookie('second-token');
    expect(store.token).toBe('second-token');
    expect(ui.columns).toEqual([]);
    expect(firstTimeline.nextPage).toBeUndefined();

    ui.hydrateFromServer('second-token', {
      'ui:columns': '["federated"]',
      'ui:show_trending': null,
    });
    const secondTimeline = timelines.getTimeline('recommended');
    secondTimeline.statusIds = ['second-private'];
    store.syncTokenFromCookie(null);
    expect(store.token).toBeNull();
    expect(ui.columns).toEqual([]);
    expect(secondTimeline.statusIds).toEqual([]);
    expect(timelines.timelines.size).toBe(0);
  });

  it('restores token from cookie', () => {
    document.cookie = 'siliconbeest_token=saved-token; Path=/';
    const store = useAuthStore();
    // Token should be restored on init
    expect(store.token).toBe('saved-token');
  });

  it('reports isAuthenticated when token present', () => {
    document.cookie = 'siliconbeest_token=saved-token; Path=/';
    const store = useAuthStore();
    expect(store.isAuthenticated).toBe(true);
  });

  it('clears state on logout', async () => {
    const store = useAuthStore();
    const timelines = useTimelinesStore();
    store.setToken('test-token');
    const timeline = timelines.getTimeline('recommended');
    timeline.statusIds = ['private-status'];
    timeline.nextPage = '/api/v1/timelines/recommended?cursor=private';
    await store.logout();
    expect(store.token).toBeNull();
    expect(store.isAuthenticated).toBe(false);
    expect(document.cookie).not.toContain('siliconbeest_token=');
    expect(timeline.statusIds).toEqual([]);
    expect(timeline.nextPage).toBeUndefined();
    expect(timelines.timelines.size).toBe(0);
  });

  it('clearToken also nulls currentUser', () => {
    const store = useAuthStore();
    store.setToken('test-token');
    // manually set currentUser to something
    store.currentUser = { id: '1', username: 'test' } as any;
    store.clearToken();
    expect(store.currentUser).toBeNull();
  });

  it('clearToken clears per-account UI preferences', () => {
    const store = useAuthStore();
    const ui = useUiStore();
    store.setToken('test-token');
    ui.hydrateFromServer('test-token', {
      'ui:columns': '["home"]',
      'ui:show_trending': null,
    });

    store.clearToken();

    expect(ui.columns).toEqual([]);
    expect(ui.serverLoaded).toBe(false);
  });

  it('ignores a previous account user response and its loading completion', async () => {
    const oldRequest = deferred<Response>();
    const currentRequest = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => oldRequest.promise)
      .mockImplementationOnce(() => currentRequest.promise));
    const store = useAuthStore();

    store.setToken('old-token');
    const oldFetch = store.fetchCurrentUser();
    store.setToken('current-token');
    const currentFetch = store.fetchCurrentUser();

    oldRequest.resolve(credentialResponse('old-user'));
    await oldFetch;

    expect(store.token).toBe('current-token');
    expect(store.currentUser).toBeNull();
    expect(store.error).toBeNull();
    expect(store.loading).toBe(true);

    currentRequest.reject(new Error('current request failed'));
    await currentFetch;
    expect(store.error).toBe('current request failed');
    expect(store.loading).toBe(false);
  });

  it('ignores an older same-token request error and loading completion', async () => {
    const oldRequest = deferred<Response>();
    const currentRequest = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => oldRequest.promise)
      .mockImplementationOnce(() => currentRequest.promise));
    const store = useAuthStore();
    store.setToken('shared-token');

    const oldFetch = store.fetchCurrentUser();
    const currentFetch = store.fetchCurrentUser();
    oldRequest.reject(new Error('stale failure'));
    await oldFetch;

    expect(store.error).toBeNull();
    expect(store.loading).toBe(true);

    currentRequest.reject(new Error('current failure'));
    await currentFetch;
    expect(store.error).toBe('current failure');
    expect(store.loading).toBe(false);
  });

  it('does not let a stale 401 log out the current account', async () => {
    const oldRequest = deferred<Response>();
    const currentRequest = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => oldRequest.promise)
      .mockImplementationOnce(() => currentRequest.promise));
    const store = useAuthStore();

    store.setToken('old-token');
    const oldFetch = store.fetchCurrentUser();
    store.setToken('current-token');
    const currentFetch = store.fetchCurrentUser();

    oldRequest.resolve(new Response(JSON.stringify({ error: 'expired' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }));
    await oldFetch;

    expect(store.token).toBe('current-token');
    expect(store.error).toBeNull();
    expect(store.loading).toBe(true);

    currentRequest.reject(new Error('current request failed'));
    await currentFetch;
    expect(store.token).toBe('current-token');
    expect(store.error).toBe('current request failed');
    expect(store.loading).toBe(false);
  });

  it('isAdmin is false when no user', () => {
    const store = useAuthStore();
    expect(store.isAdmin).toBe(false);
  });

  it('isModerator is false when no user', () => {
    const store = useAuthStore();
    expect(store.isModerator).toBe(false);
  });
});
