<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { withCurrentDesign } from '@/utils/safeRedirect'

const { t } = useI18n()
const route = useRoute()

const username = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')
const passkeyLoading = ref(false)

const supportsPasskeys = computed(() => typeof window !== 'undefined' && !!window.PublicKeyCredential)
const registerTarget = computed(() => ({
  path: withCurrentDesign('/register', route.path),
  query: route.query.redirect ? { redirect: route.query.redirect } : undefined,
}))

const props = defineProps<{ serverError?: string }>()
const emit = defineEmits<{
  submit: [credentials: { username: string; password: string }]
  passkey: []
}>()

function finishLogin() {
  loading.value = false
}

function finishPasskey() {
  passkeyLoading.value = false
}

defineExpose({ finishLogin, finishPasskey })

function handleSubmit() {
  if (!username.value || !password.value) return
  loading.value = true
  error.value = ''
  emit('submit', { username: username.value, password: password.value })
}

function handlePasskeyLogin() {
  passkeyLoading.value = true
  error.value = ''
  emit('passkey')
}
</script>

<template>
  <form
    id="login-form"
    data-login-endpoint="/api/v1/auth/login"
    @submit.prevent.stop="handleSubmit"
    class="space-y-4"
  >
    <h1 class="text-2xl font-bold text-center">{{ t('auth.sign_in') }}</h1>

    <div
      id="login-static-error"
      class="hidden p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm"
      role="alert"
    ></div>

    <!-- Error -->
    <div v-if="error || props.serverError" class="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm" role="alert">
      {{ error || props.serverError }}
    </div>

    <!-- Username -->
    <div>
      <label for="login-username" class="block text-sm font-medium mb-1">{{ t('auth.username') }}</label>
      <input
        id="login-username"
        name="username"
        v-model="username"
        type="text"
        required
        autocomplete="username"
        class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
        :placeholder="t('auth.username_placeholder')"
      />
    </div>

    <!-- Password -->
    <div>
      <label for="login-password" class="block text-sm font-medium mb-1">{{ t('auth.password') }}</label>
      <input
        id="login-password"
        name="password"
        v-model="password"
        type="password"
        required
        autocomplete="current-password"
        class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
        :placeholder="t('auth.password_placeholder')"
      />
    </div>

    <!-- Forgot password / Find username -->
    <div class="flex justify-between text-sm">
      <router-link :to="withCurrentDesign('/auth/find-username', route.path)" class="text-indigo-600 dark:text-indigo-400 hover:underline">
        {{ t('auth.find_username') }}
      </router-link>
      <router-link :to="withCurrentDesign('/auth/forgot-password', route.path)" class="text-indigo-600 dark:text-indigo-400 hover:underline">
        {{ t('auth.forgot_password') }}
      </router-link>
    </div>

    <!-- Submit -->
    <button
      type="button"
      data-login-submit
      :disabled="loading"
      class="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold transition-colors disabled:opacity-50"
      @click="handleSubmit"
    >
      {{ loading ? t('common.loading') : t('auth.sign_in') }}
    </button>

    <!-- Divider -->
    <div class="flex items-center gap-3 text-gray-400 dark:text-gray-500">
      <hr class="flex-1 border-gray-200 dark:border-gray-700" />
      <span class="text-xs">{{ t('auth.or') }}</span>
      <hr class="flex-1 border-gray-200 dark:border-gray-700" />
    </div>

    <!-- Passkey login -->
    <button
      v-if="supportsPasskeys"
      type="button"
      @click="handlePasskeyLogin"
      :disabled="passkeyLoading"
      class="w-full py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 font-medium hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
    >
      {{ passkeyLoading ? t('common.loading') : t('webauthn.sign_in_with_passkey') }}
    </button>

    <!-- Register link -->
    <p class="text-center text-sm text-gray-500 dark:text-gray-400">
      {{ t('auth.no_account') }}
      <router-link :to="registerTarget" class="text-indigo-600 dark:text-indigo-400 hover:underline font-medium">
        {{ t('auth.sign_up') }}
      </router-link>
    </p>
  </form>
</template>
