<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import {
  cancelRegistration,
  completeRegistration,
  continueRegistration,
  getRegistrationSession,
  logoutRegistration,
  resendRegistrationEmail,
  verifyRegistrationEmail,
} from '@/api/mastodon/registration'
import { getApiErrorMessage } from '@/utils/apiError'
import { getSafeRedirect, withCurrentDesign } from '@/utils/safeRedirect'
import type {
  RegistrationActivation,
  RegistrationSession,
} from '@/types/registration'

const props = withDefaults(defineProps<{ legacy?: boolean }>(), {
  legacy: false,
})

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const session = ref<RegistrationSession | null>(null)
const activation = ref<RegistrationActivation | null>(null)
const loading = ref(true)
const actionLoading = ref(false)
const error = ref('')
const code = ref('')
const resendSucceeded = ref(false)

const state = computed(() => activation.value?.state ?? session.value?.state ?? null)
const redirectTarget = computed(() => getSafeRedirect(
  activation.value?.redirect_uri || session.value?.redirect_uri,
  '/home',
))
const securityTarget = computed(() => ({
  path: withCurrentDesign('/settings/security', route.path),
  query: { redirect: redirectTarget.value },
}))
const supportsPasskeys = computed(
  () => typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined',
)
const verificationExpiry = computed(() => {
  const value = session.value?.email_verification_expires_at
  return value ? new Date(value).toLocaleString() : ''
})

async function loadSession() {
  loading.value = true
  error.value = ''
  try {
    const completionTicket = Array.isArray(route.query.ticket)
      ? route.query.ticket[0]
      : route.query.ticket
    if (completionTicket) {
      const token = auth.syncTokenFromCookie()
      if (token) {
        const { data } = await completeRegistration(completionTicket)
        await auth.fetchCurrentUser()
        if (auth.currentUser) {
          activation.value = {
            state: 'active',
            access_token: token,
            redirect_uri: data.redirect_uri,
            passkey_prompt: data.passkey_prompt,
          }
          if (typeof window !== 'undefined') {
            window.history.replaceState(window.history.state, '', route.path)
          }
          return
        }
      }
    }

    const { data } = await getRegistrationSession()
    session.value = data
  } catch (requestError) {
    error.value = getApiErrorMessage(
      requestError,
      t('auth.registration_session_missing'),
    )
  } finally {
    loading.value = false
  }
}

async function finishActivation(result: RegistrationActivation) {
  auth.setToken(result.access_token)
  await auth.fetchCurrentUser()
  activation.value = result
  if (session.value) session.value.state = 'active'
}

async function handleContinue() {
  actionLoading.value = true
  error.value = ''
  try {
    const { data } = await continueRegistration()
    if (data.state === 'active') {
      await finishActivation(data)
      return
    }

    if (session.value) {
      session.value.state = 'email_verification'
      session.value.email_verification_expires_at = data.email_verification_expires_at
    }
  } catch (requestError) {
    error.value = getApiErrorMessage(requestError, t('common.error'))
  } finally {
    actionLoading.value = false
  }
}

function updateCode(event: Event) {
  const target = event.target as HTMLInputElement
  code.value = target.value.replace(/\D/g, '').slice(0, 6)
}

async function handleVerify() {
  if (!/^\d{6}$/.test(code.value)) return
  actionLoading.value = true
  error.value = ''
  resendSucceeded.value = false
  try {
    const { data } = await verifyRegistrationEmail(code.value)
    await finishActivation(data)
  } catch (requestError) {
    error.value = getApiErrorMessage(requestError, t('common.error'))
  } finally {
    actionLoading.value = false
  }
}

async function handleResend() {
  actionLoading.value = true
  error.value = ''
  resendSucceeded.value = false
  try {
    const { data } = await resendRegistrationEmail()
    if (session.value) {
      session.value.email_verification_expires_at = data.email_verification_expires_at
    }
    resendSucceeded.value = true
  } catch (requestError) {
    error.value = getApiErrorMessage(requestError, t('common.error'))
  } finally {
    actionLoading.value = false
  }
}

async function handleCancel() {
  if (!window.confirm(t('auth.registration_cancel_confirm'))) return
  actionLoading.value = true
  error.value = ''
  try {
    await cancelRegistration()
    await router.push(withCurrentDesign('/', route.path))
  } catch (requestError) {
    error.value = getApiErrorMessage(requestError, t('common.error'))
  } finally {
    actionLoading.value = false
  }
}

async function handlePendingLogout() {
  actionLoading.value = true
  error.value = ''
  try {
    await logoutRegistration()
    await router.push(withCurrentDesign('/login', route.path))
  } catch (requestError) {
    error.value = getApiErrorMessage(requestError, t('common.error'))
  } finally {
    actionLoading.value = false
  }
}

async function finish() {
  await router.push(withCurrentDesign(redirectTarget.value, route.path))
}

onMounted(loadSession)
</script>

<template>
  <div
    :class="legacy
      ? 'min-h-screen bg-gray-50 px-4 py-12 dark:bg-gray-900'
      : 'sb-app relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-12'"
  >
    <div v-if="!legacy" class="sb-aurora" aria-hidden="true"></div>
    <main class="relative z-10 mx-auto w-full max-w-lg">
      <div
        :class="legacy
          ? 'rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800'
          : 'sb-card p-6 sm:p-8'"
      >
        <div v-if="loading" class="py-10 text-center text-sm text-slate-500 dark:text-slate-400">
          {{ t('common.loading') }}
        </div>

        <div v-else-if="!session && !activation" class="space-y-5 text-center">
          <h1 :class="legacy ? 'text-2xl font-bold' : 'sb-heading text-2xl'">
            {{ t('auth.registration_session_missing') }}
          </h1>
          <div v-if="error" class="rounded-xl bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400" role="alert">
            {{ error }}
          </div>
          <router-link :to="withCurrentDesign('/login', route.path)" :class="legacy ? 'inline-flex rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white' : 'sb-btn sb-btn-primary'">
            {{ t('auth.sign_in') }}
          </router-link>
        </div>

        <div v-else class="space-y-5">
          <div v-if="error" class="rounded-xl bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400" role="alert">
            {{ error }}
          </div>

          <template v-if="state === 'pending_approval'">
            <div class="text-center">
              <h1 :class="legacy ? 'text-2xl font-bold' : 'sb-heading text-2xl'">{{ t('auth.registration_pending_title') }}</h1>
              <p class="mt-3 text-sm text-slate-600 dark:text-slate-400">{{ t('auth.registration_pending_description') }}</p>
            </div>
            <dl class="rounded-xl bg-slate-50 p-4 text-sm dark:bg-slate-900/50">
              <div class="flex justify-between gap-4">
                <dt class="text-slate-500 dark:text-slate-400">{{ t('auth.username') }}</dt>
                <dd class="font-medium">@{{ session?.username }}</dd>
              </div>
              <div class="mt-2 flex justify-between gap-4">
                <dt class="text-slate-500 dark:text-slate-400">{{ t('auth.email') }}</dt>
                <dd class="truncate font-medium">{{ session?.email }}</dd>
              </div>
            </dl>
            <button type="button" :disabled="actionLoading" :class="legacy ? 'w-full rounded-lg border border-gray-300 px-4 py-2 font-semibold dark:border-gray-600' : 'sb-btn sb-btn-secondary w-full'" @click="handlePendingLogout">
              {{ actionLoading ? t('common.loading') : t('auth.registration_pending_logout') }}
            </button>
            <button type="button" :disabled="actionLoading" :class="legacy ? 'w-full rounded-lg border border-red-300 px-4 py-2 font-semibold text-red-600 disabled:opacity-50 dark:border-red-700 dark:text-red-400' : 'sb-btn w-full border border-red-200 text-red-600 disabled:opacity-50 dark:border-red-900/60 dark:text-red-400'" @click="handleCancel">
              {{ t('auth.registration_cancel') }}
            </button>
          </template>

          <template v-else-if="state === 'awaiting_confirmation'">
            <div class="text-center">
              <h1 :class="legacy ? 'text-2xl font-bold' : 'sb-heading text-2xl'">{{ t('auth.registration_confirmation_title') }}</h1>
              <p class="mt-3 text-sm text-slate-600 dark:text-slate-400">
                {{ t('auth.registration_confirmation_description', { username: session?.username }) }}
              </p>
            </div>
            <div v-if="session?.invited_by" class="flex items-center gap-3 rounded-xl bg-brand-50 p-4 dark:bg-brand-950/40">
              <img :src="session.invited_by.avatar || '/default-avatar.svg'" :alt="session.invited_by.display_name || session.invited_by.username" class="h-10 w-10 rounded-full object-cover" />
              <p class="text-sm">
                {{ t('auth.registration_invited_by') }}
                <strong>{{ session.invited_by.display_name || `@${session.invited_by.username}` }}</strong>
              </p>
            </div>
            <button type="button" :disabled="actionLoading" :class="legacy ? 'w-full rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white disabled:opacity-50' : 'sb-btn sb-btn-primary w-full'" @click="handleContinue">
              {{ actionLoading ? t('common.loading') : t('auth.registration_continue') }}
            </button>
            <button type="button" :disabled="actionLoading" :class="legacy ? 'w-full rounded-lg border border-red-300 px-4 py-2 font-semibold text-red-600 dark:border-red-700 dark:text-red-400' : 'sb-btn w-full border border-red-200 text-red-600 dark:border-red-900/60 dark:text-red-400'" @click="handleCancel">
              {{ t('auth.registration_cancel') }}
            </button>
          </template>

          <template v-else-if="state === 'email_verification'">
            <div class="text-center">
              <h1 :class="legacy ? 'text-2xl font-bold' : 'sb-heading text-2xl'">{{ t('auth.registration_verification_title') }}</h1>
              <p class="mt-3 text-sm text-slate-600 dark:text-slate-400">
                {{ t('auth.registration_verification_description', { email: session?.email }) }}
              </p>
              <p v-if="verificationExpiry" class="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {{ t('auth.registration_verification_expires', { time: verificationExpiry }) }}
              </p>
            </div>
            <form class="space-y-4" @submit.prevent="handleVerify">
              <div>
                <label for="registration-code" :class="legacy ? 'mb-1 block text-sm font-medium' : 'sb-label'">{{ t('auth.registration_verification_code') }}</label>
                <input
                  id="registration-code"
                  :value="code"
                  type="text"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxlength="6"
                  required
                  :class="legacy ? 'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-center text-2xl tracking-[0.4em] dark:border-gray-600 dark:bg-gray-700' : 'sb-input text-center text-2xl tracking-[0.4em]'"
                  @input="updateCode"
                />
              </div>
              <button type="submit" :disabled="actionLoading || code.length !== 6" :class="legacy ? 'w-full rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white disabled:opacity-50' : 'sb-btn sb-btn-primary w-full'">
                {{ actionLoading ? t('common.loading') : t('auth.registration_verify') }}
              </button>
            </form>
            <p v-if="resendSucceeded" class="rounded-xl bg-emerald-50 p-3 text-center text-sm text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
              {{ t('auth.registration_resend_success') }}
            </p>
            <div class="flex gap-3">
              <button type="button" :disabled="actionLoading" :class="legacy ? 'flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold dark:border-gray-600' : 'sb-btn sb-btn-secondary flex-1'" @click="handleResend">
                {{ t('auth.registration_resend') }}
              </button>
              <button type="button" :disabled="actionLoading" :class="legacy ? 'flex-1 rounded-lg border border-red-300 px-3 py-2 text-sm font-semibold text-red-600 dark:border-red-700 dark:text-red-400' : 'sb-btn flex-1 border border-red-200 text-red-600 dark:border-red-900/60 dark:text-red-400'" @click="handleCancel">
                {{ t('auth.registration_cancel') }}
              </button>
            </div>
          </template>

          <template v-else-if="state === 'active'">
            <div class="text-center">
              <div class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-3xl text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">✓</div>
              <h1 :class="legacy ? 'mt-4 text-2xl font-bold' : 'sb-heading mt-4 text-2xl'">{{ t('auth.registration_complete_title') }}</h1>
              <p class="mt-3 text-sm text-slate-600 dark:text-slate-400">{{ t('auth.registration_complete_description') }}</p>
            </div>
            <div v-if="activation?.passkey_prompt && supportsPasskeys" class="rounded-xl border border-brand-200 bg-brand-50 p-4 dark:border-brand-500/30 dark:bg-brand-950/40">
              <h2 class="font-semibold text-slate-900 dark:text-white">{{ t('auth.registration_passkey_title') }}</h2>
              <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">{{ t('auth.registration_passkey_description') }}</p>
              <router-link :to="securityTarget" :class="legacy ? 'mt-4 inline-flex rounded-lg border border-indigo-300 px-4 py-2 text-sm font-semibold text-indigo-700 dark:border-indigo-700 dark:text-indigo-300' : 'sb-btn sb-btn-secondary mt-4'">
                {{ t('auth.registration_add_passkey') }}
              </router-link>
            </div>
            <button type="button" :class="legacy ? 'w-full rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white' : 'sb-btn sb-btn-primary w-full'" @click="finish">
              {{ t('auth.registration_finish') }}
            </button>
          </template>
        </div>
      </div>
    </main>
  </div>
</template>
