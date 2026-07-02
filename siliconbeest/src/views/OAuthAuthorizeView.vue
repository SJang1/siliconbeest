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
  <div class="sb-app relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-12">
    <div class="sb-aurora" aria-hidden="true"></div>
    <div class="relative z-10 w-full max-w-md animate-rise-in">
      <!-- Loading -->
      <div v-if="loading" class="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
        {{ t('common.loading') }}
      </div>

      <!-- Error -->
      <div v-else-if="error && !appInfo" class="sb-card p-8">
        <div class="text-center">
          <div class="sb-heading mb-2 text-lg text-red-600 dark:text-red-400">{{ t('oauth.error_title') }}</div>
          <p class="text-sm text-slate-600 dark:text-slate-400">{{ error }}</p>
        </div>
      </div>

      <!-- Authorization form -->
      <div v-else-if="appInfo" class="sb-card divide-y divide-outline overflow-hidden dark:divide-outline-dark">
        <!-- Header -->
        <div class="p-8 pb-6">
          <h1 class="sb-heading text-xl text-slate-900 dark:text-white">{{ t('oauth.authorize_app') }}</h1>
          <p class="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
            {{ t('oauth.app_wants_access', { name: appInfo.name }) }}
          </p>
          <a
            v-if="appInfo.website"
            :href="appInfo.website"
            target="_blank"
            rel="noopener noreferrer"
            class="mt-1.5 inline-block text-xs font-medium text-brand-600 hover:text-brand-500 hover:underline dark:text-brand-400 dark:hover:text-brand-300"
          >
            {{ appInfo.website }}
          </a>
        </div>

        <!-- Logged in as -->
        <div v-if="auth.currentUser" class="bg-surface-2 px-8 py-3 dark:bg-surface-2-dark">
          <div class="flex items-center gap-3">
            <span v-if="auth.currentUser.avatar" class="sb-avatar-ring shrink-0">
              <img
                :src="auth.currentUser.avatar"
                :alt="auth.currentUser.display_name || auth.currentUser.username"
                class="block h-8 w-8 rounded-full"
              />
            </span>
            <div class="text-sm">
              <div class="font-medium text-slate-900 dark:text-white">
                {{ auth.currentUser.display_name || auth.currentUser.username }}
              </div>
              <div class="text-slate-500 dark:text-slate-400">
                @{{ auth.currentUser.acct }}
              </div>
            </div>
          </div>
        </div>

        <!-- Requested permissions -->
        <div class="p-8 py-6">
          <h2 class="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{{ t('oauth.requested_permissions') }}</h2>
          <ul class="space-y-2">
            <li v-for="s in scopeList" :key="s">
              <span class="sb-chip w-full justify-start gap-2 whitespace-normal rounded-xl px-3 py-2 text-sm">
                <svg class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                </svg>
                <span>{{ scopeDescription(s) }}</span>
              </span>
            </li>
          </ul>
        </div>

        <div class="p-8 pt-6">
          <!-- Error -->
          <div v-if="error" class="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400">
            {{ error }}
          </div>

          <!-- Buttons -->
          <div class="flex gap-3">
            <button
              @click="authorize('deny')"
              :disabled="submitting"
              class="sb-btn sb-btn-secondary flex-1"
            >
              {{ t('oauth.deny') }}
            </button>
            <button
              @click="authorize('approve')"
              :disabled="submitting"
              class="sb-btn sb-btn-primary flex-1"
            >
              {{ submitting ? t('oauth.authorizing') : t('oauth.authorize') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
