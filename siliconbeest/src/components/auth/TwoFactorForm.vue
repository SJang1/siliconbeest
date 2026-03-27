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
    <h1 class="text-2xl font-bold text-center">{{ t('auth.two_factor') }}</h1>
    <p class="text-sm text-gray-500 dark:text-gray-400 text-center">
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
        class="w-full px-4 py-3 text-center text-2xl tracking-[0.5em] rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
        :placeholder="useBackup ? '________' : '000000'"
      />
    </div>

    <!-- Submit -->
    <button
      type="submit"
      :disabled="loading || !code.trim()"
      class="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold transition-colors disabled:opacity-50"
    >
      {{ loading ? t('common.loading') : t('auth.verify') }}
    </button>

    <!-- Toggle backup -->
    <button
      type="button"
      @click="useBackup = !useBackup; code = ''"
      class="w-full text-center text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
    >
      {{ useBackup ? t('auth.use_totp') : t('auth.use_backup') }}
    </button>
  </form>
</template>
