<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import LoginForm from '@/components/auth/LoginForm.vue'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const error = ref('')
const loginFormRef = ref<InstanceType<typeof LoginForm> | null>(null)

async function handleLogin(credentials: { username: string; password: string; turnstile_token?: string }) {
  error.value = ''
  try {
    await auth.login(credentials.username, credentials.password, credentials.turnstile_token)
    const redirect = (route.query.redirect as string) || '/home'
    router.push(redirect)
  } catch (e: any) {
    error.value = e.message || t('error.unauthorized')
  } finally {
    if (loginFormRef.value) loginFormRef.value.loading = false
  }
}

async function handlePasskey() {
  error.value = ''
  try {
    await auth.loginWithPasskey()
    const redirect = (route.query.redirect as string) || '/home'
    router.push(redirect)
  } catch (e: any) {
    if (e.name === 'NotAllowedError') {
      error.value = t('webauthn.error_cancelled')
    } else if (e.name === 'AbortError') {
      error.value = t('webauthn.error_cancelled')
    } else if (e.message?.includes('not confirmed')) {
      error.value = t('auth.email_not_confirmed')
    } else {
      error.value = e.message || t('webauthn.error_failed')
    }
  } finally {
    if (loginFormRef.value) loginFormRef.value.passkeyLoading = false
  }
}

</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
    <div class="w-full max-w-sm">
      <div class="text-center mb-8">
        <h1 class="text-3xl font-bold text-indigo-600 dark:text-indigo-400">SiliconBeest</h1>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">{{ t('auth.welcome') }}</p>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
        <!-- Loading overlay -->
        <div v-if="auth.loading" class="text-center py-4 text-gray-500">
          {{ t('common.loading') }}
        </div>
        <LoginForm v-else ref="loginFormRef" :server-error="error" @submit="handleLogin" @passkey="handlePasskey" />
      </div>
    </div>
  </div>
</template>
