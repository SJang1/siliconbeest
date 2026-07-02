<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const code = ref('')
const useBackup = ref(false)
const loading = ref(false)

const emit = defineEmits<{
  submit: [payload: { code: string; isBackup: boolean }]
}>()

function handleSubmit() {
  if (!code.value.trim()) return
  loading.value = true
  emit('submit', { code: code.value.trim(), isBackup: useBackup.value })
  loading.value = false
}
</script>

<template>
  <form @submit.prevent="handleSubmit" class="space-y-4">
    <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-300" aria-hidden="true">
      <svg class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" /></svg>
    </div>
    <h1 class="sb-heading text-center text-2xl">{{ t('auth.two_factor') }}</h1>
    <p class="text-center text-sm text-slate-500 dark:text-slate-400">
      {{ useBackup ? t('auth.enter_backup_code') : t('auth.enter_2fa_code') }}
    </p>

    <!-- Code input -->
    <div>
      <label for="2fa-code" class="sr-only">{{ t('auth.code') }}</label>
      <input
        id="2fa-code"
        v-model="code"
        :type="useBackup ? 'text' : 'text'"
        :maxlength="useBackup ? 20 : 6"
        :pattern="useBackup ? undefined : '[0-9]{6}'"
        inputmode="numeric"
        autocomplete="one-time-code"
        required
        class="sb-input px-4 py-3 text-center font-mono text-2xl tracking-[0.5em]"
        :placeholder="useBackup ? '________' : '000000'"
      />
    </div>

    <!-- Submit -->
    <button
      type="submit"
      :disabled="loading || !code.trim()"
      class="sb-btn sb-btn-primary w-full"
    >
      {{ loading ? t('common.loading') : t('auth.verify') }}
    </button>

    <!-- Toggle backup -->
    <button
      type="button"
      @click="useBackup = !useBackup; code = ''"
      class="w-full text-center text-sm font-medium text-brand-600 hover:text-brand-500 hover:underline dark:text-brand-400 dark:hover:text-brand-300"
    >
      {{ useBackup ? t('auth.use_totp') : t('auth.use_backup') }}
    </button>
  </form>
</template>
