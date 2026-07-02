<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTurnstile } from '@/composables/useTurnstile'
import { ALL_LOCALES, getDisplayLocale } from '@/i18n'

const { t, locale } = useI18n()
const { token: turnstileToken, isEnabled: turnstileEnabled, render: renderTurnstile, reset: resetTurnstile } = useTurnstile()

const props = defineProps<{
  registrationOpen?: boolean
  registrationMode?: string
  registrationMessage?: string
}>()

const emit = defineEmits<{
  submit: [data: {
    username: string
    email: string
    password: string
    locale: string
    reason?: string
    turnstile_token?: string
  }]
}>()

const username = ref('')
const email = ref('')
const password = ref('')
const confirmPassword = ref('')
const agreement = ref(false)
const defaultLocale = ref(getDisplayLocale())
const reason = ref('')
const loading = ref(false)
const error = ref('')

const isApprovalMode = computed(() => props.registrationMode === 'approval')

const passwordsMatch = computed(() => password.value === confirmPassword.value)

const canSubmit = computed(() =>
  username.value &&
  email.value &&
  password.value &&
  passwordsMatch.value &&
  agreement.value &&
  !loading.value &&
  (!isApprovalMode.value || reason.value.trim())
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
    locale: defaultLocale.value,
    reason: isApprovalMode.value ? reason.value.trim() : undefined,
    turnstile_token: turnstileToken.value || undefined,
  })
  loading.value = false
}
</script>

<template>
  <form @submit.prevent="handleSubmit" class="space-y-4">
    <h1 class="sb-heading text-center text-2xl">{{ t('auth.sign_up') }}</h1>

    <!-- Error -->
    <div v-if="error" class="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400" role="alert">
      <svg class="mt-0.5 h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.008v.008H12v-.008z" /></svg>
      <span>{{ error }}</span>
    </div>

    <!-- Registration closed -->
    <div v-if="registrationOpen === false" class="rounded-xl border border-amber-200 bg-amber-50 p-4 text-center text-sm font-medium text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
      {{ t('auth.registration_closed') }}
    </div>

    <template v-else>
      <!-- Admin registration message -->
      <div v-if="registrationMessage" class="rounded-xl border border-brand-200 bg-brand-50 p-3 text-sm text-brand-700 dark:border-brand-500/30 dark:bg-brand-950/40 dark:text-brand-300">
        <strong>{{ t('auth.admin_message') }}</strong>
        <p class="mt-1">{{ registrationMessage }}</p>
      </div>

      <!-- Username -->
      <div>
        <label for="reg-username" class="sb-label">{{ t('auth.username') }}</label>
        <input
          id="reg-username"
          v-model="username"
          type="text"
          required
          autocomplete="username"
          class="sb-input"
        />
      </div>

      <!-- Email -->
      <div>
        <label for="reg-email" class="sb-label">{{ t('auth.email') }}</label>
        <input
          id="reg-email"
          v-model="email"
          type="email"
          required
          autocomplete="email"
          class="sb-input"
        />
      </div>

      <!-- Password -->
      <div>
        <label for="reg-password" class="sb-label">{{ t('auth.password') }}</label>
        <input
          id="reg-password"
          v-model="password"
          type="password"
          required
          minlength="8"
          autocomplete="new-password"
          class="sb-input"
        />
      </div>

      <!-- Confirm Password -->
      <div>
        <label for="reg-confirm" class="sb-label">{{ t('auth.confirm_password') }}</label>
        <input
          id="reg-confirm"
          v-model="confirmPassword"
          type="password"
          required
          autocomplete="new-password"
          class="sb-input"
          :class="{ 'border-red-400 focus:border-red-400 focus:ring-red-500/20 dark:border-red-500/50': confirmPassword && !passwordsMatch }"
        />
        <p v-if="confirmPassword && !passwordsMatch" class="mt-1.5 flex items-center gap-1.5 text-xs text-red-500 dark:text-red-400">
          <svg class="h-3.5 w-3.5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
          {{ t('auth.passwords_no_match') }}
        </p>
      </div>

      <!-- Default Language -->
      <div>
        <label for="reg-locale" class="sb-label">{{ t('auth.default_language') }}</label>
        <select
          id="reg-locale"
          v-model="defaultLocale"
          class="sb-input"
        >
          <option v-for="loc in ALL_LOCALES" :key="loc.code" :value="loc.code">
            {{ loc.name }}
          </option>
        </select>
      </div>

      <!-- Signup Reason (approval mode only) -->
      <div v-if="isApprovalMode">
        <label for="reg-reason" class="sb-label">{{ t('auth.signup_reason') }}</label>
        <textarea
          id="reg-reason"
          v-model="reason"
          rows="3"
          maxlength="1000"
          required
          :placeholder="t('auth.signup_reason_placeholder')"
          class="sb-input resize-none"
        />
      </div>

      <!-- Agreement -->
      <label class="flex cursor-pointer items-start gap-2.5">
        <input v-model="agreement" type="checkbox" required class="mt-0.5 h-4 w-4 rounded border-outline text-brand-600 accent-brand-600 focus:ring-brand-500 dark:border-outline-dark dark:bg-surface-2-dark" />
        <span class="text-sm text-slate-600 dark:text-slate-400">
          <router-link to="/about" class="font-medium text-brand-600 underline hover:text-brand-500 dark:text-brand-400 dark:hover:text-brand-300">{{ t('auth.server_rules') }}</router-link>,
          <router-link to="/terms" class="font-medium text-brand-600 underline hover:text-brand-500 dark:text-brand-400 dark:hover:text-brand-300">{{ t('legal.terms_of_service') }}</router-link>,
          <router-link to="/privacy" class="font-medium text-brand-600 underline hover:text-brand-500 dark:text-brand-400 dark:hover:text-brand-300">{{ t('legal.privacy_policy') }}</router-link>{{ t('auth.agreement_suffix') }}
        </span>
      </label>

      <!-- Turnstile CAPTCHA -->
      <div v-if="turnstileEnabled" id="turnstile-register" class="flex justify-center"></div>

      <!-- Submit -->
      <button
        type="submit"
        :disabled="!canSubmit"
        class="sb-btn sb-btn-primary w-full"
      >
        {{ loading ? t('common.loading') : t('auth.sign_up') }}
      </button>
    </template>

    <!-- Login link -->
    <p class="text-center text-sm text-slate-500 dark:text-slate-400">
      {{ t('auth.have_account') }}
      <router-link to="/login" class="font-medium text-brand-600 hover:text-brand-500 hover:underline dark:text-brand-400 dark:hover:text-brand-300">
        {{ t('auth.sign_in') }}
      </router-link>
    </p>
  </form>
</template>
