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
          class="sb-input flex items-center justify-between gap-2 text-left"
        >
          <span class="truncate">{{ localeMap[locale] || locale }}</span>
          <svg class="h-4 w-4 flex-shrink-0 text-slate-400 dark:text-slate-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
        </ListboxButton>
        <ListboxOptions
          class="sb-menu absolute z-10 mt-1.5 max-h-60 w-full overflow-auto focus:outline-none"
        >
          <ListboxOption
            v-for="loc in SUPPORTED_LOCALES"
            :key="loc.code"
            :value="loc.code"
            class="sb-menu-item cursor-pointer justify-between"
            :class="{ 'bg-brand-50 font-semibold text-brand-700 dark:bg-brand-950/50 dark:text-brand-300': loc.code === locale }"
          >
            <span class="truncate">{{ loc.name }}</span>
            <svg v-if="loc.code === locale" class="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
          </ListboxOption>
        </ListboxOptions>
      </div>
    </Listbox>
  </div>
</template>
