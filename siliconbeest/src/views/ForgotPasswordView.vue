<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { apiFetch } from '@/api/client'

const { t } = useI18n()

const email = ref('')
const loading = ref(false)
const sent = ref(false)
const error = ref('')

async function handleSubmit() {
  if (!email.value) return
  loading.value = true
  error.value = ''
  try {
    await apiFetch('/v1/auth/passwords', {
      method: 'POST',
      body: JSON.stringify({ email: email.value }),
    })
  } catch {
    // Always show success to avoid email enumeration
  }
  sent.value = true
  loading.value = false
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
    <div class="w-full max-w-sm">
      <div class="text-center mb-8">
        <h1 class="text-3xl font-bold text-indigo-600 dark:text-indigo-400">SiliconBeest</h1>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">{{ t('passwords.forgot_title') }}</p>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
        <!-- Success message -->
        <div v-if="sent" class="space-y-4">
          <div class="p-3 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 text-sm">
            {{ t('passwords.reset_sent') }}
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
          <p class="text-sm text-gray-600 dark:text-gray-400">
            {{ t('passwords.forgot_description') }}
          </p>

          <div v-if="error" class="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm" role="alert">
            {{ error }}
          </div>

          <div>
            <label for="forgot-email" class="block text-sm font-medium mb-1">{{ t('auth.email') }}</label>
            <input
              id="forgot-email"
              v-model="email"
              type="email"
              required
              autocomplete="email"
              class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              :placeholder="t('auth.email_placeholder')"
            />
          </div>

          <button
            type="submit"
            :disabled="loading"
            class="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold transition-colors disabled:opacity-50"
          >
            {{ loading ? t('common.loading') : t('passwords.send_reset') }}
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
