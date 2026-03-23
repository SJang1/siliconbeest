<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import RegisterForm from '@/components/auth/RegisterForm.vue'

const { t } = useI18n()
const router = useRouter()

async function handleRegister(data: { username: string; email: string; password: string }) {
  // TODO: call registration API
  console.log('register', data)
  router.push('/login')
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
        <RegisterForm :registration-open="true" @submit="handleRegister" />
      </div>
    </div>
  </div>
</template>
