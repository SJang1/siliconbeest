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
    <h1 class="sb-heading text-center text-2xl">{{ t('auth.sign_in') }}</h1>

    <div
      id="login-static-error"
      class="hidden rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400"
      role="alert"
    ></div>

    <!-- Error -->
    <div v-if="error || props.serverError" class="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400" role="alert">
      <svg class="mt-0.5 h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.008v.008H12v-.008z" /></svg>
      <span>{{ error || props.serverError }}</span>
    </div>

    <!-- Username -->
    <div>
      <label for="login-username" class="sb-label">{{ t('auth.username') }}</label>
      <input
        id="login-username"
        name="username"
        v-model="username"
        type="text"
        required
        autocomplete="username"
        class="sb-input"
        :placeholder="t('auth.username_placeholder')"
      />
    </div>

    <!-- Password -->
    <div>
      <label for="login-password" class="sb-label">{{ t('auth.password') }}</label>
      <input
        id="login-password"
        name="password"
        v-model="password"
        type="password"
        required
        autocomplete="current-password"
        class="sb-input"
        :placeholder="t('auth.password_placeholder')"
      />
    </div>

    <!-- Forgot password / Find username -->
    <div class="flex justify-between text-sm">
      <router-link :to="withCurrentDesign('/auth/find-username', route.path)" class="font-medium text-brand-600 hover:text-brand-500 hover:underline dark:text-brand-400 dark:hover:text-brand-300">
        {{ t('auth.find_username') }}
      </router-link>
      <router-link :to="withCurrentDesign('/auth/forgot-password', route.path)" class="font-medium text-brand-600 hover:text-brand-500 hover:underline dark:text-brand-400 dark:hover:text-brand-300">
        {{ t('auth.forgot_password') }}
      </router-link>
    </div>

    <!-- Submit -->
    <button
      type="button"
      data-login-submit
      :disabled="loading"
      class="sb-btn sb-btn-primary w-full"
      @click="handleSubmit"
    >
      {{ loading ? t('common.loading') : t('auth.sign_in') }}
    </button>

    <!-- Divider -->
    <div class="flex items-center gap-3">
      <hr class="flex-1 border-outline dark:border-outline-dark" />
      <span class="text-xs font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500">{{ t('auth.or') }}</span>
      <hr class="flex-1 border-outline dark:border-outline-dark" />
    </div>

    <!-- Passkey login -->
    <button
      v-if="supportsPasskeys"
      type="button"
      @click="handlePasskeyLogin"
      :disabled="passkeyLoading"
      class="sb-btn sb-btn-secondary w-full"
    >
      <svg class="h-5 w-5 text-brand-500 dark:text-brand-400" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" /></svg>
      {{ passkeyLoading ? t('common.loading') : t('webauthn.sign_in_with_passkey') }}
    </button>

    <!-- Register link -->
    <p class="text-center text-sm text-slate-500 dark:text-slate-400">
      {{ t('auth.no_account') }}
      <router-link :to="registerTarget" class="font-medium text-brand-600 hover:text-brand-500 hover:underline dark:text-brand-400 dark:hover:text-brand-300">
        {{ t('auth.sign_up') }}
      </router-link>
    </p>
  </form>
</template>
