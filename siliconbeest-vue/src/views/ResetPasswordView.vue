<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { apiFetch } from '@/api/client'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const token = computed(() => (route.query.token as string) || '')
const newPassword = ref('')
const confirmPassword = ref('')
const loading = ref(false)
const error = ref('')
const success = ref(false)

async function handleSubmit() {
  error.value = ''

  if (newPassword.value !== confirmPassword.value) {
    error.value = t('auth.passwords_no_match')
    return
  }

  if (!token.value) {
    error.value = t('passwords.reset_expired')
    return
  }

  loading.value = true
  try {
    await apiFetch('/v1/auth/passwords/reset', {
      method: 'POST',
      body: JSON.stringify({
        token: token.value,
        password: newPassword.value,
      }),
    })
    success.value = true
    setTimeout(() => router.push('/login'), 2000)
  } catch (e: any) {
    if (e?.status === 410 || e?.status === 400) {
      error.value = t('passwords.reset_expired')
    } else {
      error.value = e?.description || e?.error || t('common.error')
    }
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
    <div class="w-full max-w-sm">
      <div class="text-center mb-8">
        <h1 class="text-3xl font-bold text-indigo-600 dark:text-indigo-400">SiliconBeest</h1>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">{{ t('passwords.reset_title') }}</p>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
        <!-- Success -->
        <div v-if="success" class="space-y-4">
          <div class="p-3 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 text-sm">
            {{ t('passwords.reset_success') }}
          </div>
          <router-link
            to="/login"
            class="block text-center text-sm text-indigo-600 dark:text-indigo-400 hover:underline font-medium"
          >
            {{ t('auth.sign_in') }}
          </router-link>
        </div>

        <!-- Form -->
        <form v-else @submit.prevent="handleSubmit" class="space-y-4">
          <div v-if="error" class="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm" role="alert">
            {{ error }}
          </div>

          <div>
            <label for="reset-password" class="block text-sm font-medium mb-1">{{ t('passwords.new_password') }}</label>
            <input
              id="reset-password"
              v-model="newPassword"
              type="password"
              required
              autocomplete="new-password"
              class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div>
            <label for="reset-confirm" class="block text-sm font-medium mb-1">{{ t('passwords.confirm_new_password') }}</label>
            <input
              id="reset-confirm"
              v-model="confirmPassword"
              type="password"
              required
              autocomplete="new-password"
              class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <button
            type="submit"
            :disabled="loading"
            class="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold transition-colors disabled:opacity-50"
          >
            {{ loading ? t('common.loading') : t('passwords.reset_submit') }}
          </button>

          <p class="text-center text-sm text-gray-500 dark:text-gray-400">
            <router-link to="/login" class="text-indigo-600 dark:text-indigo-400 hover:underline font-medium">
              {{ t('auth.sign_in') }}
            </router-link>
          </p>
        </form>
      </div>
    </div>
  </div>
</template>
