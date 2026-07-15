<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useTurnstile } from '@/composables/useTurnstile'
import { ALL_LOCALES, getDisplayLocale } from '@/i18n'
import { renderMarkdown } from '@/utils/markdown'
import { withCurrentDesign } from '@/utils/safeRedirect'
import type { InstanceRule } from '@/types/mastodon'
import type { InvitationPreview, RegistrationFormData, RegistrationMode } from '@/types/registration'

type RegistrationStep = 'legal' | 'credentials'

const props = defineProps<{
  registrationOpen?: boolean
  registrationMode?: RegistrationMode
  registrationMessage?: string
  rules?: InstanceRule[]
  termsOfService?: string
  privacyPolicy?: string
  invitation?: InvitationPreview | null
}>()

const emit = defineEmits<{
  submit: [data: RegistrationFormData]
}>()

const { t } = useI18n()
const route = useRoute()
const {
  token: turnstileToken,
  isEnabled: turnstileEnabled,
  render: renderTurnstile,
  reset: resetTurnstile,
} = useTurnstile()

const step = ref<RegistrationStep>('legal')
const legalAccepted = ref(false)
const username = ref('')
const email = ref('')
const password = ref('')
const confirmPassword = ref('')
const defaultLocale = ref(getDisplayLocale())
const reason = ref('')
const loading = ref(false)
const error = ref('')
const turnstileRendered = ref(false)

const isApprovalMode = computed(
  () => props.registrationMode === 'approval' && !props.invitation,
)
const passwordsMatch = computed(() => password.value === confirmPassword.value)
const termsHtml = computed(() => renderMarkdown(props.termsOfService || ''))
const privacyHtml = computed(() => renderMarkdown(props.privacyPolicy || ''))
const canSubmit = computed(() =>
  !!username.value &&
  !!email.value &&
  !!password.value &&
  passwordsMatch.value &&
  legalAccepted.value &&
  !loading.value &&
  (!isApprovalMode.value || !!reason.value.trim())
)

function tryRenderTurnstile() {
  if (step.value === 'credentials' && turnstileEnabled.value && !turnstileRendered.value) {
    renderTurnstile('turnstile-register')
    turnstileRendered.value = true
  }
}

function showCredentials() {
  if (!legalAccepted.value) return
  step.value = 'credentials'
  requestAnimationFrame(tryRenderTurnstile)
}

function showLegal() {
  if (loading.value) return
  step.value = 'legal'
}

function finishSubmission(resetCaptcha = false) {
  loading.value = false
  if (resetCaptcha) resetTurnstile()
}

defineExpose({ finishSubmission })

onMounted(tryRenderTurnstile)

watch([turnstileEnabled, step], tryRenderTurnstile)

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
    agreement: legalAccepted.value,
    reason: isApprovalMode.value ? reason.value.trim() : undefined,
    turnstile_token: turnstileToken.value || undefined,
  })
}
</script>

<template>
  <form class="space-y-5" @submit.prevent="handleSubmit">
    <h1 class="sb-heading text-center text-2xl">{{ t('auth.sign_up') }}</h1>

    <div
      v-if="registrationOpen === false"
      class="rounded-xl border border-amber-200 bg-amber-50 p-4 text-center text-sm font-medium text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
    >
      {{ registrationMode === 'referral'
        ? t('auth.registration_invite_required')
        : t('auth.registration_closed') }}
    </div>

    <template v-else>
      <div
        v-if="invitation"
        class="rounded-xl border border-brand-200 bg-brand-50 p-4 dark:border-brand-500/30 dark:bg-brand-950/40"
      >
        <div class="flex items-center gap-3">
          <img
            :src="invitation.inviter.avatar || '/default-avatar.svg'"
            :alt="invitation.inviter.display_name || invitation.inviter.username"
            class="h-11 w-11 rounded-full object-cover"
          />
          <div class="min-w-0">
            <p class="text-xs font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-300">
              {{ t('auth.registration_invited_by') }}
            </p>
            <p class="truncate font-semibold text-slate-900 dark:text-white">
              {{ invitation.inviter.display_name || invitation.inviter.username }}
            </p>
            <p class="truncate text-xs text-slate-500 dark:text-slate-400">
              @{{ invitation.inviter.username }}
            </p>
          </div>
        </div>
        <p v-if="invitation.auto_follow" class="mt-3 text-xs text-slate-600 dark:text-slate-300">
          {{ t('auth.registration_invite_auto_follow') }}
        </p>
      </div>

      <div
        v-if="registrationMessage"
        class="rounded-xl border border-brand-200 bg-brand-50 p-3 text-sm text-brand-700 dark:border-brand-500/30 dark:bg-brand-950/40 dark:text-brand-300"
      >
        <strong>{{ t('auth.admin_message') }}</strong>
        <p class="mt-1">{{ registrationMessage }}</p>
      </div>

      <div v-if="error" class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400" role="alert">
        {{ error }}
      </div>

      <template v-if="step === 'legal'">
        <div>
          <h2 class="sb-heading text-lg">{{ t('auth.registration_rules_title') }}</h2>
          <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {{ t('auth.registration_rules_description') }}
          </p>
        </div>

        <section class="max-h-52 overflow-y-auto rounded-xl border border-outline p-4 dark:border-outline-dark">
          <h3 class="sb-heading mb-3 text-sm">{{ t('auth.server_rules') }}</h3>
          <ol v-if="rules?.length" class="space-y-2 text-sm text-slate-700 dark:text-slate-300">
            <li v-for="(rule, index) in rules" :key="rule.id" class="flex gap-2">
              <span class="font-semibold text-brand-600 dark:text-brand-400">{{ index + 1 }}.</span>
              <span class="whitespace-pre-line">{{ rule.text }}</span>
            </li>
          </ol>
          <p v-else class="text-sm text-slate-500 dark:text-slate-400">{{ t('legal.no_content') }}</p>
        </section>

        <details class="rounded-xl border border-outline p-4 dark:border-outline-dark">
          <summary class="cursor-pointer font-semibold text-slate-900 dark:text-white">
            {{ t('legal.terms_of_service') }}
          </summary>
          <div v-if="termsHtml" class="prose prose-sm mt-4 max-h-52 max-w-none overflow-y-auto dark:prose-invert" v-html="termsHtml" />
          <p v-else class="mt-3 text-sm text-slate-500 dark:text-slate-400">{{ t('legal.no_content') }}</p>
        </details>

        <details class="rounded-xl border border-outline p-4 dark:border-outline-dark">
          <summary class="cursor-pointer font-semibold text-slate-900 dark:text-white">
            {{ t('legal.privacy_policy') }}
          </summary>
          <div v-if="privacyHtml" class="prose prose-sm mt-4 max-h-52 max-w-none overflow-y-auto dark:prose-invert" v-html="privacyHtml" />
          <p v-else class="mt-3 text-sm text-slate-500 dark:text-slate-400">{{ t('legal.no_content') }}</p>
        </details>

        <label class="flex cursor-pointer items-start gap-2.5">
          <input v-model="legalAccepted" type="checkbox" required class="mt-0.5 h-4 w-4 rounded border-outline accent-brand-600 dark:border-outline-dark dark:bg-surface-2-dark" />
          <span class="text-sm text-slate-600 dark:text-slate-400">
            {{ t('auth.registration_rules_agreement') }}
          </span>
        </label>

        <button type="button" :disabled="!legalAccepted" class="sb-btn sb-btn-primary w-full" @click="showCredentials">
          {{ t('common.next') }}
        </button>
      </template>

      <template v-else>
        <div>
          <label for="reg-username" class="sb-label">{{ t('auth.username') }}</label>
          <input id="reg-username" v-model="username" type="text" required autocomplete="username" maxlength="30" class="sb-input" />
        </div>

        <div>
          <label for="reg-email" class="sb-label">{{ t('auth.email') }}</label>
          <input id="reg-email" v-model="email" type="email" required autocomplete="email" class="sb-input" />
        </div>

        <div>
          <label for="reg-password" class="sb-label">{{ t('auth.password') }}</label>
          <input id="reg-password" v-model="password" type="password" required minlength="8" autocomplete="new-password" class="sb-input" />
        </div>

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
          <p v-if="confirmPassword && !passwordsMatch" class="mt-1.5 text-xs text-red-500 dark:text-red-400">
            {{ t('auth.passwords_no_match') }}
          </p>
        </div>

        <div>
          <label for="reg-locale" class="sb-label">{{ t('auth.default_language') }}</label>
          <select id="reg-locale" v-model="defaultLocale" class="sb-input">
            <option v-for="loc in ALL_LOCALES" :key="loc.code" :value="loc.code">{{ loc.name }}</option>
          </select>
        </div>

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

        <div v-if="turnstileEnabled" id="turnstile-register" class="flex justify-center"></div>

        <div class="flex gap-3">
          <button type="button" :disabled="loading" class="sb-btn sb-btn-secondary flex-1" @click="showLegal">
            {{ t('common.back') }}
          </button>
          <button type="submit" :disabled="!canSubmit" class="sb-btn sb-btn-primary flex-1">
            {{ loading ? t('common.loading') : t('auth.sign_up') }}
          </button>
        </div>
      </template>
    </template>

    <p class="text-center text-sm text-slate-500 dark:text-slate-400">
      {{ t('auth.have_account') }}
      <router-link :to="withCurrentDesign('/login', route.path)" class="font-medium text-brand-600 hover:underline dark:text-brand-400">
        {{ t('auth.sign_in') }}
      </router-link>
    </p>
  </form>
</template>
