<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useComposeStore } from '@/stores/compose'
import type { StatusVisibility } from '@/types/mastodon'

const { t } = useI18n()
const compose = useComposeStore()

const visibilityOptions: { value: StatusVisibility; labelKey: string; icon: string }[] = [
  { value: 'public', labelKey: 'compose.visibility.public', icon: '🌐' },
  { value: 'unlisted', labelKey: 'compose.visibility.unlisted', icon: '🔓' },
  { value: 'private', labelKey: 'compose.visibility.private', icon: '🔒' },
  { value: 'direct', labelKey: 'compose.visibility.direct', icon: '✉️' },
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
</script>

<template>
  <div class="p-4 w-full">
    <h2 class="text-xl font-bold mb-6 text-gray-900 dark:text-white">{{ t('settings.posting') }}</h2>

    <div class="space-y-6">
      <div>
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {{ t('settings.posting_default_visibility') }}
        </label>
        <p class="text-xs text-gray-500 dark:text-gray-400 mb-3">
          {{ t('settings.posting_default_visibility_desc') }}
        </p>
        <div class="grid grid-cols-2 gap-3">
          <button
            v-for="opt in visibilityOptions"
            :key="opt.value"
            :disabled="saving"
            class="flex items-center gap-2 px-4 py-3 rounded-lg border-2 text-sm font-medium transition-colors disabled:opacity-50"
            :class="
              compose.defaultVisibility === opt.value
                ? 'border-indigo-600 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-900/20 dark:text-indigo-300'
                : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
            "
            @click="selectVisibility(opt.value)"
          >
            <span>{{ opt.icon }}</span>
            <span>{{ t(opt.labelKey) }}</span>
          </button>
        </div>
        <p v-if="saved" class="mt-2 text-sm text-green-600 dark:text-green-400">
          {{ t('settings.posting_visibility_saved') }}
        </p>
      </div>
    </div>
  </div>
</template>
