<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const email = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')

const emit = defineEmits<{
  submit: [credentials: { email: string; password: string }]
  sso: [provider: string]
}>()

async function handleSubmit() {
  if (!email.value || !password.value) return
  loading.value = true
  error.value = ''
  emit('submit', { email: email.value, password: password.value })
  loading.value = false
}
</script>

<template>
  <form @submit.prevent="handleSubmit" class="space-y-4">
    <h1 class="text-2xl font-bold text-center">{{ t('auth.sign_in') }}</h1>

    <!-- Error -->
    <div v-if="error" class="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm" role="alert">
      {{ error }}
    </div>

    <!-- Email -->
    <div>
      <label for="login-email" class="block text-sm font-medium mb-1">{{ t('auth.email') }}</label>
      <input
        id="login-email"
        v-model="email"
        type="email"
        required
        autocomplete="email"
        class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        :placeholder="t('auth.email_placeholder')"
      />
    </div>

    <!-- Password -->
    <div>
      <label for="login-password" class="block text-sm font-medium mb-1">{{ t('auth.password') }}</label>
      <input
        id="login-password"
        v-model="password"
        type="password"
        required
        autocomplete="current-password"
        class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        :placeholder="t('auth.password_placeholder')"
      />
    </div>

    <!-- Forgot password -->
    <div class="text-right">
      <router-link to="/auth/forgot" class="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">
        {{ t('auth.forgot_password') }}
      </router-link>
    </div>

    <!-- Submit -->
    <button
      type="submit"
      :disabled="loading"
      class="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold transition-colors disabled:opacity-50"
    >
      {{ loading ? t('common.loading') : t('auth.sign_in') }}
    </button>

    <!-- Divider -->
    <div class="flex items-center gap-3 text-gray-400 dark:text-gray-500">
      <hr class="flex-1 border-gray-200 dark:border-gray-700" />
      <span class="text-xs">{{ t('auth.or') }}</span>
      <hr class="flex-1 border-gray-200 dark:border-gray-700" />
    </div>

    <!-- SSO -->
    <button
      type="button"
      @click="emit('sso', 'google')"
      class="w-full py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 font-medium hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
    >
      {{ t('auth.sign_in_google') }}
    </button>

    <!-- Register link -->
    <p class="text-center text-sm text-gray-500 dark:text-gray-400">
      {{ t('auth.no_account') }}
      <router-link to="/register" class="text-indigo-600 dark:text-indigo-400 hover:underline font-medium">
        {{ t('auth.sign_up') }}
      </router-link>
    </p>
  </form>
</template>
