<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useComposeStore } from '@/stores/compose'
import type { StatusVisibility, QuotePolicy } from '@/types/mastodon'

const { t } = useI18n()
const compose = useComposeStore()

const visibilityOptions: { value: StatusVisibility; labelKey: string; icon: string }[] = [
  { value: 'public', labelKey: 'compose.visibility.public', icon: '🌐' },
  { value: 'unlisted', labelKey: 'compose.visibility.unlisted', icon: '🔓' },
  { value: 'private', labelKey: 'compose.visibility.private', icon: '🔒' },
  { value: 'direct', labelKey: 'compose.visibility.direct', icon: '✉️' },
]

const quotePolicyOptions: { value: QuotePolicy; labelKey: string; descKey: string }[] = [
  { value: 'public', labelKey: 'settings.quote_policy_public', descKey: 'settings.quote_policy_public_desc' },
  { value: 'followers', labelKey: 'settings.quote_policy_followers', descKey: 'settings.quote_policy_followers_desc' },
  { value: 'nobody', labelKey: 'settings.quote_policy_nobody', descKey: 'settings.quote_policy_nobody_desc' },
]

const saving = ref(false)
const saved = ref(false)

async function selectVisibility(v: StatusVisibility) {
  if (saving.value || v === compose.defaultVisibility) return
  saving.value = true
  saved.value = false
  try {
    await compose.setDefaultVisibility(v)
    saved.value = true
    setTimeout(() => { saved.value = false }, 2000)
  } finally {
    saving.value = false
  }
}

async function selectQuotePolicy(policy: QuotePolicy) {
  if (saving.value || policy === compose.defaultQuotePolicy) return
  saving.value = true
  saved.value = false
  try {
    await compose.setDefaultQuotePolicy(policy)
    saved.value = true
    setTimeout(() => { saved.value = false }, 2000)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="w-full">
    <h2 class="sb-heading text-xl mb-6">{{ t('settings.posting') }}</h2>

    <div class="space-y-6">
      <div class="sb-card p-6">
        <label class="sb-label">
          {{ t('settings.posting_default_visibility') }}
        </label>
        <p class="text-xs text-slate-500 dark:text-slate-400 mb-3">
          {{ t('settings.posting_default_visibility_desc') }}
        </p>
        <div class="grid grid-cols-2 gap-3">
          <button
            v-for="opt in visibilityOptions"
            :key="opt.value"
            :disabled="saving"
            class="flex items-center gap-2 px-4 py-3 rounded-xl border-2 text-sm font-medium transition-colors disabled:opacity-50"
            :class="
              compose.defaultVisibility === opt.value
                ? 'border-brand-500 bg-brand-50 text-brand-700 dark:border-brand-400 dark:bg-brand-950/40 dark:text-brand-300'
                : 'border-outline text-slate-600 hover:border-brand-300 hover:text-slate-900 dark:border-outline-dark dark:text-slate-300 dark:hover:border-brand-700 dark:hover:text-white'
            "
            @click="selectVisibility(opt.value)"
          >
            <span>{{ opt.icon }}</span>
            <span>{{ t(opt.labelKey) }}</span>
          </button>
        </div>
        <p v-if="saved" class="mt-3 text-sm text-green-600 dark:text-green-400">
          {{ t('settings.posting_visibility_saved') }}
        </p>
      </div>

      <div class="sb-card p-6">
        <label class="sb-label">
          {{ t('settings.default_quote_policy') }}
        </label>
        <p class="text-xs text-slate-500 dark:text-slate-400 mb-3">
          {{ t('settings.default_quote_policy_desc') }}
        </p>
        <div class="space-y-2">
          <button
            v-for="opt in quotePolicyOptions"
            :key="opt.value"
            :disabled="saving"
            class="w-full flex items-start gap-3 px-4 py-3 rounded-xl border-2 text-left transition-colors disabled:opacity-50"
            :class="
              compose.defaultQuotePolicy === opt.value
                ? 'border-brand-500 bg-brand-50 text-brand-700 dark:border-brand-400 dark:bg-brand-950/40 dark:text-brand-300'
                : 'border-outline text-slate-600 hover:border-brand-300 hover:text-slate-900 dark:border-outline-dark dark:text-slate-300 dark:hover:border-brand-700 dark:hover:text-white'
            "
            @click="selectQuotePolicy(opt.value)"
          >
            <span class="mt-0.5">💬</span>
            <span>
              <span class="block text-sm font-semibold">{{ t(opt.labelKey) }}</span>
              <span class="block text-xs text-slate-500 dark:text-slate-400">{{ t(opt.descKey) }}</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
