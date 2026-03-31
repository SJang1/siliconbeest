<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const loading = ref(true)
const error = ref('')
const submitting = ref(false)

const appInfo = ref<{
  name: string
  website: string | null
  scopes: string
} | null>(null)

const clientId = computed(() => (route.query.client_id as string) || '')
const redirectUri = computed(() => (route.query.redirect_uri as string) || '')
const scope = computed(() => (route.query.scope as string) || 'read')
const state = computed(() => (route.query.state as string) || '')
const responseType = computed(() => (route.query.response_type as string) || 'code')

const scopeList = computed(() => {
  if (!scope.value) return []
  return scope.value.split(/\s+/).filter(Boolean)
})

function scopeDescription(s: string): string {
  // Try i18n key first, fall back to raw scope name
  const key = `oauth.scope.${s}`
  const translated = t(key)
  return translated !== key ? translated : s
}

onMounted(async () => {
  // If not authenticated, redirect to login with return URL
  if (!auth.isAuthenticated) {
    const oauthParams = new URLSearchParams()
    if (clientId.value) oauthParams.set('client_id', clientId.value)
    if (redirectUri.value) oauthParams.set('redirect_uri', redirectUri.value)
    if (scope.value) oauthParams.set('scope', scope.value)
    if (state.value) oauthParams.set('state', state.value)
    if (responseType.value) oauthParams.set('response_type', responseType.value)
    const returnUrl = `/oauth/authorize?${oauthParams.toString()}`
    router.replace({ name: 'login', query: { redirect: returnUrl } })
    return
  }

  // Fetch current user if not loaded
  if (!auth.currentUser) {
    await auth.fetchCurrentUser()
  }

  // Fetch app info from the server
  try {
    const params = new URLSearchParams()
    if (clientId.value) params.set('client_id', clientId.value)
    if (redirectUri.value) params.set('redirect_uri', redirectUri.value)
    if (scope.value) params.set('scope', scope.value)
    if (state.value) params.set('state', state.value)
    if (responseType.value) params.set('response_type', responseType.value)

    const res = await fetch(`/oauth/authorize?${params.toString()}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${auth.token}`,
      },
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: t('oauth.error_unknown_app') }))
      error.value = err.error || t('oauth.error_failed')
      return
    }

    const data = await res.json()
    appInfo.value = data.app
  } catch (e: any) {
    error.value = e.message || t('oauth.error_failed')
  } finally {
    loading.value = false
  }
})

async function authorize(decision: 'approve' | 'deny') {
  submitting.value = true
  error.value = ''
  try {
    const res = await fetch('/oauth/authorize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({
        client_id: clientId.value,
        redirect_uri: redirectUri.value,
        scope: scope.value,
        state: state.value,
        response_type: responseType.value,
        decision: decision,
      }),
    })

    const data = await res.json()
    if (data.redirect_uri) {
      window.location.href = data.redirect_uri
    } else if (data.error) {
      error.value = data.error
    }
  } catch (e: any) {
    error.value = e.message || t('oauth.error_failed')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
    <div class="w-full max-w-md">
      <!-- Loading -->
      <div v-if="loading" class="text-center py-12 text-gray-500 dark:text-gray-400">
        {{ t('common.loading') }}
      </div>

      <!-- Error -->
      <div v-else-if="error && !appInfo" class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
        <div class="text-center">
          <div class="text-red-500 text-lg font-semibold mb-2">{{ t('oauth.error_title') }}</div>
          <p class="text-gray-600 dark:text-gray-400 text-sm">{{ error }}</p>
        </div>
      </div>

      <!-- Authorization form -->
      <div v-else-if="appInfo" class="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
        <!-- Header -->
        <div class="p-6 border-b border-gray-200 dark:border-gray-700">
          <h1 class="text-xl font-bold text-gray-900 dark:text-white">{{ t('oauth.authorize_app') }}</h1>
          <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {{ t('oauth.app_wants_access', { name: appInfo.name }) }}
          </p>
          <a
            v-if="appInfo.website"
            :href="appInfo.website"
            target="_blank"
            rel="noopener noreferrer"
            class="text-xs text-indigo-600 dark:text-indigo-400 hover:underline mt-1 inline-block"
          >
            {{ appInfo.website }}
          </a>
        </div>

        <!-- Logged in as -->
        <div v-if="auth.currentUser" class="px-6 py-3 bg-gray-50 dark:bg-gray-750 border-b border-gray-200 dark:border-gray-700">
          <div class="flex items-center gap-3">
            <img
              v-if="auth.currentUser.avatar"
              :src="auth.currentUser.avatar"
              :alt="auth.currentUser.display_name || auth.currentUser.username"
              class="w-8 h-8 rounded-full"
            />
            <div class="text-sm">
              <div class="font-medium text-gray-900 dark:text-white">
                {{ auth.currentUser.display_name || auth.currentUser.username }}
              </div>
              <div class="text-gray-500 dark:text-gray-400">
                @{{ auth.currentUser.acct }}
              </div>
            </div>
          </div>
        </div>

        <!-- Requested permissions -->
        <div class="p-6 border-b border-gray-200 dark:border-gray-700">
          <h2 class="text-sm font-semibold text-gray-900 dark:text-white mb-3">{{ t('oauth.requested_permissions') }}</h2>
          <ul class="space-y-2">
            <li v-for="s in scopeList" :key="s" class="flex items-start gap-2 text-sm">
              <svg class="w-4 h-4 mt-0.5 text-indigo-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              <span class="text-gray-700 dark:text-gray-300">
                {{ scopeDescription(s) }}
              </span>
            </li>
          </ul>
        </div>

        <!-- Error -->
        <div v-if="error" class="px-6 pt-4">
          <div class="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
            {{ error }}
          </div>
        </div>

        <!-- Buttons -->
        <div class="p-6 flex gap-3">
          <button
            @click="authorize('deny')"
            :disabled="submitting"
            class="flex-1 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
          >
            {{ t('oauth.deny') }}
          </button>
          <button
            @click="authorize('approve')"
            :disabled="submitting"
            class="flex-1 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold transition-colors disabled:opacity-50"
          >
            {{ submitting ? t('oauth.authorizing') : t('oauth.authorize') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
