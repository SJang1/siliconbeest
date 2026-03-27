<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { apiFetch } from '@/api/client'

const { t } = useI18n()
const auth = useAuthStore()

const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const loading = ref(false)
const error = ref('')
const success = ref('')

async function handleChangePassword() {
  error.value = ''
  success.value = ''

  if (newPassword.value !== confirmPassword.value) {
    error.value = t('auth.passwords_no_match')
    return
  }

  loading.value = true
  try {
    await apiFetch('/v1/accounts/change_password', {
      method: 'POST',
      token: auth.token!,
      body: JSON.stringify({
        current_password: currentPassword.value,
        new_password: newPassword.value,
      }),
    })
    success.value = t('passwords.change_success')
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
  } catch (e: any) {
    if (e?.status === 401 || e?.status === 403) {
      error.value = t('passwords.wrong_password')
    } else {
      error.value = e?.description || e?.error || t('common.error')
    }
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div>
    <h2 class="text-xl font-bold mb-6">{{ t('settings.account') }}</h2>

    <!-- Change Password Section -->
    <div class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
      <h3 class="text-lg font-semibold mb-4">{{ t('passwords.change_title') }}</h3>

      <div v-if="success" class="mb-4 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 text-sm">
        {{ success }}
      </div>

      <div v-if="error" class="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm" role="alert">
        {{ error }}
      </div>

      <form @submit.prevent="handleChangePassword" class="space-y-4 max-w-xl">
        <div>
          <label for="current-password" class="block text-sm font-medium mb-1">{{ t('passwords.current_password') }}</label>
          <input
            id="current-password"
            v-model="currentPassword"
            type="password"
            required
            autocomplete="current-password"
            class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label for="new-password" class="block text-sm font-medium mb-1">{{ t('passwords.new_password') }}</label>
          <input
            id="new-password"
            v-model="newPassword"
            type="password"
            required
            autocomplete="new-password"
            class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label for="confirm-new-password" class="block text-sm font-medium mb-1">{{ t('passwords.confirm_new_password') }}</label>
          <input
            id="confirm-new-password"
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
          class="px-6 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold transition-colors disabled:opacity-50"
        >
          {{ loading ? t('common.loading') : t('passwords.change_submit') }}
        </button>
      </form>
    </div>
  </div>
</template>
