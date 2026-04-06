<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { findUsername } from '@/api/mastodon/oauth'

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
    await findUsername(email.value)
    sent.value = true
  } catch (e: any) {
    error.value = e?.message || t('common.error')
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
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
        <h2 class="text-xl font-bold text-center mb-2">{{ t('auth.find_username_title') }}</h2>
        <p class="text-sm text-gray-500 dark:text-gray-400 text-center mb-6">{{ t('auth.find_username_desc') }}</p>

        <div v-if="sent" class="p-4 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 text-sm text-center">
          {{ t('auth.find_username_sent') }}
        </div>

        <form v-else @submit.prevent="handleSubmit" class="space-y-4">
          <div v-if="error" class="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
            {{ error }}
          </div>

          <div>
            <label for="find-email" class="block text-sm font-medium mb-1">{{ t('auth.email') }}</label>
            <input
              id="find-email"
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
            {{ loading ? t('common.loading') : t('auth.find_username_submit') }}
          </button>
        </form>

        <p class="text-center text-sm text-gray-500 dark:text-gray-400 mt-4">
          <router-link to="/login" class="text-indigo-600 dark:text-indigo-400 hover:underline font-medium">
            {{ t('auth.sign_in') }}
          </router-link>
        </p>
      </div>
    </div>
  </div>
</template>
