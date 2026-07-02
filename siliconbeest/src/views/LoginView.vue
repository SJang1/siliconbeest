<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter, useRoute } from 'vue-router'
import { useHead } from '#imports'
import { useAuthStore } from '@/stores/auth'
import { useInstanceStore } from '@/stores/instance'
import LoginForm from '@/components/auth/LoginForm.vue'

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
  <div class="sb-app relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-12">
    <div class="sb-aurora" aria-hidden="true"></div>
    <div class="relative z-10 w-full max-w-md animate-rise-in">
      <div class="mb-8 text-center">
        <h1 class="sb-heading sb-gradient-text text-4xl">{{ instanceTitle }}</h1>
        <p class="mt-3 text-sm text-slate-500 dark:text-slate-400">{{ t('auth.welcome') }}</p>
      </div>
      <div class="sb-card p-8">
        <!-- Loading overlay -->
        <div v-if="auth.loading" class="py-4 text-center text-sm text-slate-500 dark:text-slate-400">
          {{ t('common.loading') }}
        </div>
        <LoginForm v-else ref="loginFormRef" :server-error="error" @submit="handleLogin" @passkey="handlePasskey" />
      </div>
    </div>
  </div>
</template>
