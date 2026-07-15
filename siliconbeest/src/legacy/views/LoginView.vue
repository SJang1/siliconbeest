<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter, useRoute } from 'vue-router'
import { useHead } from '#imports'
import { useAuthStore } from '@/stores/auth'
import { useInstanceStore } from '@/stores/instance'
import { getApiErrorMessage, hasErrorName } from '@/utils/apiError'
import { getSafeRedirect, withCurrentDesign } from '@/utils/safeRedirect'
import LoginForm from '@/legacy/components/auth/LoginForm.vue'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const instanceStore = useInstanceStore()
const error = ref('')
const loginFormRef = ref<InstanceType<typeof LoginForm> | null>(null)
const instanceTitle = computed(() => instanceStore.instance?.title)

useHead({
  script: [{ src: '/login-form.js', defer: true }],
})

onMounted(() => {
  (window as Window & { __SILICONBEEST_LOGIN_VUE_READY__?: boolean }).__SILICONBEEST_LOGIN_VUE_READY__ = true
})

async function handleLogin(credentials: { username: string; password: string; turnstile_token?: string }) {
  error.value = ''
  let failed = false
  try {
    const result = await auth.login(credentials.username, credentials.password, credentials.turnstile_token)
    if (result.type === 'registration_required') {
      await router.push(withCurrentDesign('/auth/registration', route.path))
      return
    }
    await router.push(withCurrentDesign(getSafeRedirect(route.query.redirect), route.path))
  } catch (requestError) {
    failed = true
    error.value = getApiErrorMessage(requestError, t('error.unauthorized'))
  } finally {
    loginFormRef.value?.finishLogin(failed)
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
  <div class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
    <div class="w-full max-w-sm">
      <div class="text-center mb-8">
        <h1 class="text-3xl font-bold text-indigo-600 dark:text-indigo-400">{{ instanceTitle }}</h1>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">{{ t('auth.welcome') }}</p>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
        <LoginForm ref="loginFormRef" :server-error="error" @submit="handleLogin" @passkey="handlePasskey" />
      </div>
    </div>
  </div>
</template>
