<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Listbox, ListboxButton, ListboxOptions, ListboxOption } from '@headlessui/vue'

const { t, locale, availableLocales } = useI18n()

const localeLabels: Record<string, string> = {
  en: 'English',
  ko: '한국어',
  ja: '日本語',
  zh: '中文',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
}

function setLocale(newLocale: string) {
  locale.value = newLocale
}
</script>

<template>
  <div>
    <label class="block text-sm font-medium mb-1">{{ t('settings.language') }}</label>
    <Listbox :model-value="locale" @update:model-value="setLocale">
      <div class="relative">
        <ListboxButton
          class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-left focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          {{ localeLabels[locale] || locale }}
        </ListboxButton>
        <ListboxOptions
          class="absolute mt-1 w-full rounded-lg bg-white dark:bg-gray-800 shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-10 max-h-60 overflow-auto"
        >
          <ListboxOption
            v-for="loc in availableLocales"
            :key="loc"
            :value="loc"
            class="px-3 py-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 text-sm"
            :class="{ 'bg-indigo-50 dark:bg-indigo-900/20 font-medium': loc === locale }"
          >
            {{ localeLabels[loc] || loc }}
          </ListboxOption>
        </ListboxOptions>
      </div>
    </Listbox>
  </div>
</template>
