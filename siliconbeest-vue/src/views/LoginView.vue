<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import LoginForm from '@/components/auth/LoginForm.vue'

const { t } = useI18n()
const router = useRouter()

async function handleLogin(credentials: { email: string; password: string }) {
  // TODO: call auth API
  console.log('login', credentials)
  router.push('/')
}

function handleSso(provider: string) {
  // TODO: initiate SSO flow
  console.log('sso', provider)
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
        <LoginForm @submit="handleLogin" @sso="handleSso" />
      </div>
    </div>
  </div>
</template>
