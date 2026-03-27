<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import RegisterForm from '@/components/auth/RegisterForm.vue'

const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()

const error = ref<string | null>(null)

async function handleRegister(data: { username: string; email: string; password: string; turnstile_token?: string; agreement?: boolean }) {
  error.value = null
  try {
    const result = await auth.register({
      username: data.username,
      email: data.email,
      password: data.password,
      agreement: true,
      turnstile_token: data.turnstile_token,
    })
    if (result.confirmationRequired) {
      router.push({ path: '/auth/confirm-email-sent', query: { email: data.email } })
    } else {
      router.push('/home')
    }
  } catch (e) {
    error.value = (e as Error).message
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
    <div class="w-full max-w-sm">
      <div class="text-center mb-8">
        <h1 class="text-3xl font-bold text-indigo-600 dark:text-indigo-400">SiliconBeest</h1>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">{{ t('auth.join_us') }}</p>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
        <div v-if="error" class="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
          {{ error }}
        </div>
        <RegisterForm :registration-open="true" @submit="handleRegister" />
      </div>
    </div>
  </div>
</template>
