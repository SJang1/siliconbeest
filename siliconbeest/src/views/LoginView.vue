<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter, useRoute } from 'vue-router'
import { useHead } from '#imports'
import { useAuthStore } from '@/stores/auth'
import { useInstanceStore } from '@/stores/instance'
import { getLoginPreflightStatus } from '@/api/mastodon/oauth'
import { getApiErrorMessage, hasErrorName } from '@/utils/apiError'
import { getSafeRedirect, withCurrentDesign } from '@/utils/safeRedirect'
import LoginBotGate from '@/components/auth/LoginBotGate.vue'
import LoginForm from '@/components/auth/LoginForm.vue'

type LoginPreflightState = 'loading' | 'challenge' | 'ready' | 'error'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const instanceStore = useInstanceStore()
const error = ref('')
const loginFormRef = ref<InstanceType<typeof LoginForm> | null>(null)
const instanceTitle = computed(() => instanceStore.instance?.title)
const preflightState = ref<LoginPreflightState>('loading')
const preflightSiteKey = ref('')
const preflightReturnTo = computed(() => route.fullPath)

useHead({
  script: [{ src: '/login-form.js', defer: true }],
})

onMounted(() => {
  (window as Window & { __SILICONBEEST_LOGIN_VUE_READY__?: boolean }).__SILICONBEEST_LOGIN_VUE_READY__ = true
  void loadLoginPreflight()
})

async function loadLoginPreflight() {
  preflightState.value = 'loading'
  preflightSiteKey.value = ''

  try {
    const { data } = await getLoginPreflightStatus()
    if (data.required && !data.passed) {
      if (!data.site_key) {
        preflightState.value = 'error'
        return
      }
      preflightSiteKey.value = data.site_key
      preflightState.value = 'challenge'
      return
    }
    preflightState.value = 'ready'
  } catch {
    preflightState.value = 'error'
  }
}

async function handleLogin(credentials: { username: string; password: string }) {
  error.value = ''
  try {
    const result = await auth.login(credentials.username, credentials.password)
    if (result.type === 'registration_required') {
      await router.push(withCurrentDesign('/auth/registration', route.path))
      return
    }
    await router.push(withCurrentDesign(getSafeRedirect(route.query.redirect), route.path))
  } catch (requestError) {
    error.value = getApiErrorMessage(requestError, t('error.unauthorized'))
  } finally {
    loginFormRef.value?.finishLogin()
  }
}

async function handlePasskey() {
  error.value = ''
  try {
    await auth.loginWithPasskey()
    await router.push(withCurrentDesign(getSafeRedirect(route.query.redirect), route.path))
  } catch (requestError) {
    if (hasErrorName(requestError, ['NotAllowedError', 'AbortError'])) {
      error.value = t('webauthn.error_cancelled')
    } else if (requestError instanceof Error && requestError.message.includes('not confirmed')) {
      error.value = t('auth.email_not_confirmed')
    } else {
      error.value = getApiErrorMessage(requestError, t('webauthn.error_failed'))
    }
  } finally {
    loginFormRef.value?.finishPasskey()
  }
}

</script>

<template>
  <div class="sb-app relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-12">
    <div class="sb-aurora" aria-hidden="true"></div>
    <div class="relative z-10 w-full max-w-md animate-rise-in">
      <div class="mb-8 text-center">
        <h1 class="sb-heading sb-gradient-text text-4xl">{{ instanceTitle }}</h1>
        <p class="mt-3 text-sm text-slate-500 dark:text-slate-400">{{ t('auth.welcome') }}</p>
      </div>
      <div class="sb-card p-8">
        <LoginForm
          v-if="preflightState === 'ready'"
          ref="loginFormRef"
          :server-error="error"
          @submit="handleLogin"
          @passkey="handlePasskey"
        />
        <LoginBotGate
          v-else-if="preflightState === 'challenge'"
          :site-key="preflightSiteKey"
          :return-to="preflightReturnTo"
        />
        <div v-else class="space-y-4 text-center">
          <p
            :role="preflightState === 'error' ? 'alert' : 'status'"
            class="text-sm text-slate-500 dark:text-slate-400"
          >
            {{
              preflightState === 'error'
                ? t('login_preflight.status_error')
                : t('login_preflight.loading')
            }}
          </p>
          <button
            v-if="preflightState === 'error'"
            type="button"
            class="sb-btn sb-btn-secondary w-full"
            @click="loadLoginPreflight"
          >
            {{ t('login_preflight.retry') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
