<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTurnstile } from '@/composables/useTurnstile'

const { t } = useI18n()
const { token: turnstileToken, isEnabled: turnstileEnabled, render: renderTurnstile, reset: resetTurnstile } = useTurnstile()

defineProps<{
  registrationOpen?: boolean
}>()

const emit = defineEmits<{
  submit: [data: { username: string; email: string; password: string; turnstile_token?: string }]
}>()

const username = ref('')
const email = ref('')
const password = ref('')
const confirmPassword = ref('')
const agreement = ref(false)
const loading = ref(false)
const error = ref('')

const passwordsMatch = computed(() => password.value === confirmPassword.value)

const canSubmit = computed(() =>
  username.value &&
  email.value &&
  password.value &&
  passwordsMatch.value &&
  agreement.value &&
  !loading.value
)

const turnstileRendered = ref(false)

function tryRenderTurnstile() {
  if (turnstileEnabled.value && !turnstileRendered.value) {
    renderTurnstile('turnstile-register')
    turnstileRendered.value = true
  }
}

onMounted(() => {
  tryRenderTurnstile()
})

watch(turnstileEnabled, (enabled) => {
  if (enabled) tryRenderTurnstile()
})

function handleSubmit() {
  if (!canSubmit.value) return
  if (turnstileEnabled.value && !turnstileToken.value) {
    error.value = t('turnstile.verification_failed')
    return
  }
  loading.value = true
  error.value = ''
  emit('submit', {
    username: username.value,
    email: email.value,
    password: password.value,
    turnstile_token: turnstileToken.value || undefined,
  })
  loading.value = false
}
</script>

<template>
  <form @submit.prevent="handleSubmit" class="space-y-4">
    <h1 class="text-2xl font-bold text-center">{{ t('auth.sign_up') }}</h1>

    <!-- Error -->
    <div v-if="error" class="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm" role="alert">
      {{ error }}
    </div>

    <!-- Registration closed -->
    <div v-if="registrationOpen === false" class="p-4 rounded-lg bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-300 text-sm text-center">
      {{ t('auth.registration_closed') }}
    </div>

    <template v-else>
      <!-- Username -->
      <div>
        <label for="reg-username" class="block text-sm font-medium mb-1">{{ t('auth.username') }}</label>
        <input
          id="reg-username"
          v-model="username"
          type="text"
          required
          autocomplete="username"
          class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>

      <!-- Email -->
      <div>
        <label for="reg-email" class="block text-sm font-medium mb-1">{{ t('auth.email') }}</label>
        <input
          id="reg-email"
          v-model="email"
          type="email"
          required
          autocomplete="email"
          class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>

      <!-- Password -->
      <div>
        <label for="reg-password" class="block text-sm font-medium mb-1">{{ t('auth.password') }}</label>
        <input
          id="reg-password"
          v-model="password"
          type="password"
          required
          minlength="8"
          autocomplete="new-password"
          class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>

      <!-- Confirm Password -->
      <div>
        <label for="reg-confirm" class="block text-sm font-medium mb-1">{{ t('auth.confirm_password') }}</label>
        <input
          id="reg-confirm"
          v-model="confirmPassword"
          type="password"
          required
          autocomplete="new-password"
          class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          :class="{ 'border-red-500': confirmPassword && !passwordsMatch }"
        />
        <p v-if="confirmPassword && !passwordsMatch" class="text-xs text-red-500 mt-1">
          {{ t('auth.passwords_no_match') }}
        </p>
      </div>

      <!-- Agreement -->
      <label class="flex items-start gap-2 cursor-pointer">
        <input v-model="agreement" type="checkbox" required class="mt-1 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500" />
        <span class="text-sm text-gray-600 dark:text-gray-400">
          {{ t('auth.agreement') }}
          <router-link to="/about" class="text-indigo-500 hover:text-indigo-400 underline">{{ t('auth.server_rules') }}</router-link>
        </span>
      </label>

      <!-- Turnstile CAPTCHA -->
      <div v-if="turnstileEnabled" id="turnstile-register" class="flex justify-center"></div>

      <!-- Submit -->
      <button
        type="submit"
        :disabled="!canSubmit"
        class="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {{ loading ? t('common.loading') : t('auth.sign_up') }}
      </button>
    </template>

    <!-- Login link -->
    <p class="text-center text-sm text-gray-500 dark:text-gray-400">
      {{ t('auth.have_account') }}
      <router-link to="/login" class="text-indigo-600 dark:text-indigo-400 hover:underline font-medium">
        {{ t('auth.sign_in') }}
      </router-link>
    </p>
  </form>
</template>
