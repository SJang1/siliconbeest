<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { apiFetch, ApiError } from '@/api/client'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()
const authStore = useAuthStore()

// Local notification filter prefs (localStorage)
const PREFS_KEY = 'siliconbeest_notification_prefs'

const loading = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)
const success = ref(false)

const notificationTypes = ref([
  { key: 'follow', enabled: true },
  { key: 'favourite', enabled: true },
  { key: 'reblog', enabled: true },
  { key: 'mention', enabled: true },
  { key: 'poll', enabled: true },
])

// Web Push state
const pushLoading = ref(false)
const pushError = ref<string | null>(null)
const pushSuccess = ref(false)
const pushSubscription = ref<{
  id: string
  endpoint: string
  alerts: Record<string, boolean>
  server_key: string
} | null>(null)
const pushSupported = ref(false)
const pushPermission = ref<NotificationPermission>('default')
const pushEnabling = ref(false)
const pushSaving = ref(false)

// Push alert types for user-facing toggles
const pushAlertTypes = [
  { key: 'mention', label: 'settings.push_mention' },
  { key: 'follow', label: 'settings.push_follow' },
  { key: 'favourite', label: 'settings.push_favourite' },
  { key: 'reblog', label: 'settings.push_reblog' },
  { key: 'poll', label: 'settings.push_poll' },
  { key: 'status', label: 'settings.push_status' },
]

// iOS detection
const isIOS = computed(() => {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document)
})

onMounted(() => {
  loadPreferences()
  checkPushSupport()
  loadPushSubscription()
})

// ── Local notification prefs ──
function loadPreferences() {
  loading.value = true
  try {
    const stored = localStorage.getItem(PREFS_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as Record<string, boolean>
      notificationTypes.value.forEach((nt) => {
        if (parsed[nt.key] !== undefined) {
          nt.enabled = !!parsed[nt.key]
        }
      })
    }
  } catch {
    // Use defaults
  } finally {
    loading.value = false
  }
}

function savePreferences() {
  saving.value = true
  error.value = null
  success.value = false

  try {
    const prefs: Record<string, boolean> = {}
    notificationTypes.value.forEach((nt) => {
      prefs[nt.key] = nt.enabled
    })
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    success.value = true
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
  }
}

function toggleNotification(key: string) {
  const nt = notificationTypes.value.find((n) => n.key === key)
  if (nt) {
    nt.enabled = !nt.enabled
  }
}

// ── Web Push ──
function checkPushSupport() {
  pushSupported.value = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  if (pushSupported.value) {
    pushPermission.value = Notification.permission
  }
}

async function loadPushSubscription() {
  if (!authStore.token) return
  pushLoading.value = true
  try {
    const { data } = await apiFetch<{
      id: string
      endpoint: string
      alerts: Record<string, boolean>
      server_key: string
    }>('/v1/push/subscription', {
      token: authStore.token,
    })
    pushSubscription.value = data
  } catch (e) {
    // 404 means no subscription exists; surface other errors
    if (e instanceof ApiError && e.status === 404) {
      pushSubscription.value = null
    } else {
      pushSubscription.value = null
      pushError.value = (e as Error).message
    }
  } finally {
    pushLoading.value = false
  }
}

async function enablePush() {
  if (pushEnabling.value) return
  if (!pushSupported.value) {
    pushError.value = t('settings.push_not_supported')
    return
  }
  if (!authStore.token) {
    pushError.value = 'Not authenticated'
    return
  }

  pushEnabling.value = true
  pushError.value = null

  try {
    // 1. Ensure service worker is registered
    if (!navigator.serviceWorker.controller) {
      await navigator.serviceWorker.register('/sw.js')
    }

    // 2. Request notification permission
    const permission = await Notification.requestPermission()
    pushPermission.value = permission
    if (permission !== 'granted') {
      pushError.value = t('settings.push_permission_denied')
      return
    }

    // 3. Get the service worker registration (with timeout)
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Service worker not available. Please reload the page and try again.')), 10000),
      ),
    ])

    // 4. Get server key (VAPID public key) from instance
    let serverKey = pushSubscription.value?.server_key
    if (!serverKey) {
      const { data } = await apiFetch<{ vapid_key?: string }>('/v1/instance')
      serverKey = data.vapid_key || undefined
    }

    if (!serverKey) {
      pushError.value = 'Push notifications are not configured on this server (missing VAPID key).'
      return
    }

    // 5. Subscribe to push via browser
    const sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(serverKey) as BufferSource,
    })

    const keys = sub.toJSON().keys || {}

    // 6. Create subscription on server
    const { data } = await apiFetch<{
      id: string
      endpoint: string
      alerts: Record<string, boolean>
      server_key: string
    }>('/v1/push/subscription', {
      method: 'POST',
      token: authStore.token,
      body: {
        subscription: {
          endpoint: sub.endpoint,
          keys: {
            p256dh: keys.p256dh,
            auth: keys.auth,
          },
        },
        data: {
          alerts: {
            mention: true,
            follow: true,
            favourite: true,
            reblog: true,
            poll: true,
            status: true,
          },
        },
      },
    })

    pushSubscription.value = data
  } catch (e) {
    pushError.value = (e as Error).message
  } finally {
    pushEnabling.value = false
  }
}

async function togglePushAlert(key: string) {
  if (!pushSubscription.value || !authStore.token) return

  const newAlerts = { ...pushSubscription.value.alerts }
  newAlerts[key] = !newAlerts[key]

  pushSaving.value = true
  pushError.value = null
  pushSuccess.value = false

  try {
    const { data } = await apiFetch<{
      id: string
      endpoint: string
      alerts: Record<string, boolean>
      server_key: string
    }>('/v1/push/subscription', {
      method: 'PUT',
      token: authStore.token,
      body: JSON.stringify({
        data: {
          alerts: newAlerts,
        },
      }),
    })
    pushSubscription.value = data
    pushSuccess.value = true
  } catch (e) {
    pushError.value = (e as Error).message
  } finally {
    pushSaving.value = false
  }
}

async function disablePush() {
  if (!authStore.token) return

  pushSaving.value = true
  pushError.value = null

  try {
    await apiFetch('/v1/push/subscription', {
      method: 'DELETE',
      token: authStore.token,
    })
    pushSubscription.value = null

    // Also unsubscribe from browser push
    const registration = await navigator.serviceWorker?.ready
    const sub = await registration?.pushManager?.getSubscription()
    if (sub) await sub.unsubscribe()
  } catch (e) {
    pushError.value = (e as Error).message
  } finally {
    pushSaving.value = false
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}
</script>

<template>
  <div class="w-full">
    <h2 class="text-xl font-bold mb-6 text-gray-900 dark:text-white">{{ t('settings.notifications') }}</h2>

    <LoadingSpinner v-if="loading" />

    <div v-else class="space-y-8">
      <!-- Web Push Notification Settings -->
      <section class="space-y-4">
        <h3 class="text-lg font-semibold text-gray-900 dark:text-white">{{ t('settings.push_title') }}</h3>

        <!-- iOS PWA notice -->
        <div
          v-if="isIOS"
          class="p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 text-sm text-blue-700 dark:text-blue-300"
        >
          {{ t('settings.ios_pwa_notice') }}
        </div>

        <!-- Push not supported -->
        <div
          v-if="!pushSupported"
          class="p-3 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-sm text-gray-500 dark:text-gray-400"
        >
          {{ t('settings.push_not_supported') }}
        </div>

        <!-- Push loading -->
        <LoadingSpinner v-else-if="pushLoading" />

        <!-- Push enable button (no subscription) -->
        <div v-else-if="!pushSubscription" class="space-y-3">
          <p class="text-sm text-gray-600 dark:text-gray-400">
            {{ t('settings.push_description') }}
          </p>
          <button
            :disabled="pushEnabling"
            class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            @click="enablePush"
          >
            {{ pushEnabling ? t('common.loading') : t('settings.push_enable') }}
          </button>
        </div>

        <!-- Push alert toggles (subscription active) -->
        <div v-else class="space-y-3">
          <div class="flex items-center justify-between mb-2">
            <p class="text-sm font-medium text-green-600 dark:text-green-400">
              {{ t('settings.push_active') }}
            </p>
            <button
              class="text-xs text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300"
              @click="disablePush"
              :disabled="pushSaving"
            >
              {{ t('settings.push_disable') }}
            </button>
          </div>

          <div class="space-y-1">
            <div
              v-for="alertType in pushAlertTypes"
              :key="alertType.key"
              class="flex items-center justify-between py-2.5 border-b border-gray-100 dark:border-gray-800 last:border-0"
            >
              <span class="text-sm text-gray-900 dark:text-white">
                {{ t(alertType.label) }}
              </span>
              <button
                type="button"
                role="switch"
                :aria-checked="pushSubscription.alerts[alertType.key] ?? false"
                class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900"
                :class="pushSubscription.alerts[alertType.key] ? 'bg-indigo-600' : 'bg-gray-300 dark:bg-gray-600'"
                @click="togglePushAlert(alertType.key)"
                :disabled="pushSaving"
              >
                <span
                  class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
                  :class="pushSubscription.alerts[alertType.key] ? 'translate-x-6' : 'translate-x-1'"
                />
              </button>
            </div>
          </div>
        </div>

        <!-- Push error/success -->
        <div v-if="pushError" class="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
          {{ pushError }}
        </div>
        <div v-if="pushSuccess" class="p-3 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 text-sm">
          {{ t('settings.saved') }}
        </div>
      </section>

      <!-- Divider -->
      <hr class="border-gray-200 dark:border-gray-700" />

      <!-- Local notification filter -->
      <section class="space-y-4">
        <h3 class="text-lg font-semibold text-gray-900 dark:text-white">{{ t('settings.notif_filter_title') }}</h3>
        <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('settings.notif_filter_description') }}</p>

        <div class="space-y-1">
          <div
            v-for="nt in notificationTypes"
            :key="nt.key"
            class="flex items-center justify-between py-3 border-b border-gray-100 dark:border-gray-800 last:border-0"
          >
            <div>
              <p class="text-sm font-medium text-gray-900 dark:text-white">
                {{ t(`settings.notif_${nt.key}`) }}
              </p>
              <p class="text-xs text-gray-500 dark:text-gray-400">
                {{ t(`settings.notif_${nt.key}_desc`) }}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              :aria-checked="nt.enabled"
              class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900"
              :class="nt.enabled ? 'bg-indigo-600' : 'bg-gray-300 dark:bg-gray-600'"
              @click="toggleNotification(nt.key)"
            >
              <span
                class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
                :class="nt.enabled ? 'translate-x-6' : 'translate-x-1'"
              />
            </button>
          </div>
        </div>

        <!-- Error / Success -->
        <div v-if="error" class="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
          {{ error }}
        </div>
        <div v-if="success" class="p-3 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 text-sm">
          {{ t('settings.saved') }}
        </div>

        <button
          :disabled="saving"
          class="w-full px-4 py-2 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          @click="savePreferences"
        >
          {{ saving ? t('common.loading') : t('common.save') }}
        </button>
      </section>
    </div>
  </div>
</template>
