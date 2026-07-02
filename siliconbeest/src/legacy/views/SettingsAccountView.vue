<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { updateCredentials } from '@/api/mastodon/accounts'
import { apiFetch } from '@/api/client'
import { ALL_LOCALES } from '@/i18n'

const { t } = useI18n()
const auth = useAuthStore()

// Password change
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const loading = ref(false)
const error = ref('')
const success = ref('')

// Default language — watch for currentUser to load
const defaultLanguage = ref(auth.currentUser?.source?.language || 'en')
const savingLang = ref(false)
const langSuccess = ref(false)

watch(() => auth.currentUser?.source?.language, (lang) => {
  if (lang) defaultLanguage.value = lang
}, { immediate: true })

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

async function saveDefaultLanguage(newLocale: string) {
  defaultLanguage.value = newLocale
  savingLang.value = true
  langSuccess.value = false
  try {
    const formData = new FormData()
    formData.append('source[language]', newLocale)
    await updateCredentials(auth.token!, formData)
    await auth.fetchCurrentUser()
    langSuccess.value = true
    setTimeout(() => { langSuccess.value = false }, 2000)
  } catch {
    defaultLanguage.value = auth.currentUser?.source?.language || 'en'
  } finally {
    savingLang.value = false
  }
}
</script>

<template>
  <div>
    <h2 class="text-xl font-bold mb-6">{{ t('settings.account') }}</h2>

    <div class="space-y-6">
      <!-- Default Language Section -->
      <div class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
        <h3 class="text-lg font-semibold mb-1">{{ t('settings.default_language') }}</h3>
        <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">{{ t('settings.default_language_desc') }}</p>
        <div class="flex items-center gap-3 max-w-xs">
          <select
            :value="defaultLanguage"
            @change="saveDefaultLanguage(($event.target as HTMLSelectElement).value)"
            :disabled="savingLang"
            class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
          >
            <option v-for="loc in ALL_LOCALES" :key="loc.code" :value="loc.code">
              {{ loc.name }}
            </option>
          </select>
          <span v-if="langSuccess" class="text-sm text-green-600 dark:text-green-400 whitespace-nowrap">{{ t('settings.saved') }}</span>
        </div>
      </div>

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
  </div>
</template>
