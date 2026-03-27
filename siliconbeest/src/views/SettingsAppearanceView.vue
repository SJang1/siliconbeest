<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useUiStore, type Theme } from '@/stores/ui'
import LanguageSelector from '@/components/settings/LanguageSelector.vue'

const { t } = useI18n()
const uiStore = useUiStore()

const themes: { value: Theme; labelKey: string }[] = [
  { value: 'light', labelKey: 'settings.themeLight' },
  { value: 'dark', labelKey: 'settings.themeDark' },
  { value: 'system', labelKey: 'settings.themeSystem' },
]

function selectTheme(theme: Theme) {
  uiStore.setTheme(theme)
}
</script>

<template>
  <div class="w-full">
    <h2 class="text-xl font-bold mb-6 text-gray-900 dark:text-white">{{ t('settings.appearance') }}</h2>

    <div class="space-y-8">
      <!-- Theme -->
      <div>
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
          {{ t('settings.theme') }}
        </label>
        <div class="grid grid-cols-3 gap-3">
          <button
            v-for="theme in themes"
            :key="theme.value"
            class="px-4 py-3 rounded-lg border-2 text-sm font-medium transition-colors"
            :class="
              uiStore.theme === theme.value
                ? 'border-indigo-600 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-900/20 dark:text-indigo-300'
                : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
            "
            @click="selectTheme(theme.value)"
          >
            {{ t(theme.labelKey) }}
          </button>
        </div>
      </div>

      <!-- Language -->
      <LanguageSelector />
    </div>
  </div>
</template>
