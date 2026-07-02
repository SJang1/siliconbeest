<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Listbox, ListboxButton, ListboxOptions, ListboxOption } from '@headlessui/vue'
import { SUPPORTED_LOCALES, setDisplayLocale } from '@/i18n'

const { t, locale } = useI18n()

const localeMap = Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l.code, l.name]))

function handleLocaleChange(newLocale: string) {
  setDisplayLocale(newLocale)
}
</script>

<template>
  <div>
    <Listbox :model-value="locale" @update:model-value="handleLocaleChange">
      <div class="relative w-full max-w-xs">
        <ListboxButton
          class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-left focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          {{ localeMap[locale] || locale }}
        </ListboxButton>
        <ListboxOptions
          class="absolute mt-1 w-full rounded-lg bg-white dark:bg-gray-800 shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-10 max-h-60 overflow-auto"
        >
          <ListboxOption
            v-for="loc in SUPPORTED_LOCALES"
            :key="loc.code"
            :value="loc.code"
            class="px-3 py-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 text-sm"
            :class="{ 'bg-indigo-50 dark:bg-indigo-900/20 font-medium': loc.code === locale }"
          >
            {{ loc.name }}
          </ListboxOption>
        </ListboxOptions>
      </div>
    </Listbox>
  </div>
</template>
