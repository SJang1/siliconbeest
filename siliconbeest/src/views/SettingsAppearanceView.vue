<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Listbox, ListboxButton, ListboxOptions, ListboxOption } from '@headlessui/vue'
import { useUiStore, type Theme, type ColumnType } from '@/stores/ui'
import { useAuthStore } from '@/stores/auth'
import { updateCredentials } from '@/api/mastodon/accounts'
import LanguageSelector from '@/components/settings/LanguageSelector.vue'
import { SUPPORTED_LOCALES, ALL_LOCALES } from '@/i18n'

const { t } = useI18n()
const uiStore = useUiStore()
const auth = useAuthStore()

const themes: { value: Theme; labelKey: string }[] = [
  { value: 'light', labelKey: 'settings.themeLight' },
  { value: 'dark', labelKey: 'settings.themeDark' },
  { value: 'system', labelKey: 'settings.themeSystem' },
]

const defaultLanguage = ref(auth.currentUser?.source?.language || 'en')
const savingDefaultLang = ref(false)
const defaultLangSuccess = ref(false)

const localeMap = Object.fromEntries(ALL_LOCALES.map((l) => [l.code, l.name]))

const availableColumns: { type: ColumnType; labelKey: string }[] = [
  { type: 'home', labelKey: 'settings.column_home' },
  { type: 'local', labelKey: 'settings.column_local' },
  { type: 'federated', labelKey: 'settings.column_federated' },
  { type: 'notifications', labelKey: 'settings.column_notifications' },
]

function moveColumnUp(index: number) {
  if (index > 0) uiStore.moveColumn(index, index - 1)
}

function moveColumnDown(index: number) {
  if (index < uiStore.columns.length - 1) uiStore.moveColumn(index, index + 1)
}

function columnLabel(type: ColumnType): string {
  const map: Record<ColumnType, string> = {
    home: t('settings.column_home'),
    local: t('settings.column_local'),
    federated: t('settings.column_federated'),
    notifications: t('settings.column_notifications'),
  }
  return map[type]
}

function selectTheme(theme: Theme) {
  uiStore.setTheme(theme)
}

async function saveDefaultLanguage(newLocale: string) {
  defaultLanguage.value = newLocale
  savingDefaultLang.value = true
  defaultLangSuccess.value = false
  try {
    const formData = new FormData()
    formData.append('source[language]', newLocale)
    await updateCredentials(auth.token!, formData)
    await auth.fetchCurrentUser()
    defaultLangSuccess.value = true
    setTimeout(() => { defaultLangSuccess.value = false }, 2000)
  } catch {
    // Revert on failure
    defaultLanguage.value = auth.currentUser?.source?.language || 'en'
  } finally {
    savingDefaultLang.value = false
  }
}

const clearingCache = ref(false)
const cacheClearSuccess = ref(false)

async function clearCache() {
  clearingCache.value = true
  try {
    const names = await caches.keys()
    await Promise.all(names.map((n) => caches.delete(n)))
    cacheClearSuccess.value = true
    setTimeout(() => window.location.reload(), 800)
  } finally {
    clearingCache.value = false
  }
}

watch(() => auth.currentUser?.source?.language, (lang) => {
  if (lang) defaultLanguage.value = lang
}, { immediate: true })
</script>

<template>
  <div class="w-full">
    <h2 class="sb-heading text-xl mb-6">{{ t('settings.appearance') }}</h2>

    <div class="space-y-6">
      <!-- Theme (localStorage) -->
      <div class="sb-card p-6">
        <div class="flex items-center gap-2 mb-3">
          <label class="sb-label mb-0">
            {{ t('settings.theme') }}
          </label>
          <span class="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-surface-2-dark dark:text-slate-400">{{ t('settings.local_hint') }}</span>
        </div>
        <div class="grid grid-cols-3 gap-3">
          <button
            v-for="theme in themes"
            :key="theme.value"
            class="px-4 py-3 rounded-xl border-2 text-sm font-medium transition-colors"
            :class="
              uiStore.theme === theme.value
                ? 'border-brand-500 bg-brand-50 text-brand-700 dark:border-brand-400 dark:bg-brand-950/40 dark:text-brand-300'
                : 'border-outline text-slate-600 hover:border-brand-300 hover:text-slate-900 dark:border-outline-dark dark:text-slate-300 dark:hover:border-brand-700 dark:hover:text-white'
            "
            @click="selectTheme(theme.value)"
          >
            {{ t(theme.labelKey) }}
          </button>
        </div>
        <div class="mt-4">
          <a
            href="/old/settings/appearance"
            class="text-sm font-medium text-slate-500 underline decoration-outline underline-offset-4 transition-colors hover:text-brand-600 hover:decoration-brand-400 dark:text-slate-400 dark:decoration-outline-dark dark:hover:text-brand-400 dark:hover:decoration-brand-500"
          >{{ $t('design.backToClassic') }}</a>
        </div>
      </div>

      <!-- Language -->
      <div class="sb-card p-6 space-y-6">
        <!-- Display Language (localStorage) -->
        <div>
          <div class="flex items-center gap-2 mb-1">
            <h3 class="sb-label mb-0">{{ t('settings.display_language') }}</h3>
            <span class="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-surface-2-dark dark:text-slate-400">{{ t('settings.local_hint') }}</span>
          </div>
          <p class="text-xs text-slate-500 dark:text-slate-400 mb-3">{{ t('settings.display_language_desc') }}</p>
          <LanguageSelector />
        </div>

        <hr class="sb-divider" />

        <!-- Default Language (server-side, users.locale) -->
        <div>
          <div class="flex items-center gap-2 mb-1">
            <h3 class="sb-label mb-0">{{ t('settings.default_language') }}</h3>
            <span class="sb-chip text-[11px]">{{ t('settings.synced_hint') }}</span>
          </div>
          <p class="text-xs text-slate-500 dark:text-slate-400 mb-3">{{ t('settings.default_language_desc') }}</p>
          <div class="flex items-center gap-3">
            <Listbox :model-value="defaultLanguage" @update:model-value="saveDefaultLanguage" :disabled="savingDefaultLang">
              <div class="relative w-full max-w-xs">
                <ListboxButton
                  class="sb-input text-left disabled:opacity-50"
                >
                  {{ localeMap[defaultLanguage] || defaultLanguage }}
                </ListboxButton>
                <ListboxOptions
                  class="sb-menu absolute mt-1.5 w-full z-10 max-h-60 overflow-auto"
                >
                  <ListboxOption
                    v-for="loc in ALL_LOCALES"
                    :key="loc.code"
                    :value="loc.code"
                    class="sb-menu-item cursor-pointer"
                    :class="{ 'bg-brand-50 font-semibold text-brand-700 dark:bg-brand-950/50 dark:text-brand-300': loc.code === defaultLanguage }"
                  >
                    {{ loc.name }}
                  </ListboxOption>
                </ListboxOptions>
              </div>
            </Listbox>
            <span v-if="defaultLangSuccess" class="text-sm text-green-600 dark:text-green-400">{{ t('settings.saved') }}</span>
          </div>
        </div>
      </div>

      <!-- Layout -->
      <div class="sb-card p-6 space-y-6">
        <!-- Trending Panel (server-synced) -->
        <div>
          <div class="flex items-center gap-2 mb-1">
            <span class="sb-label mb-0">{{ t('settings.show_trending') }}</span>
            <span class="sb-chip text-[11px]">{{ t('settings.synced_hint') }}</span>
          </div>
          <label class="flex items-center justify-between gap-4 px-2 py-2.5 rounded-xl cursor-pointer hover:bg-surface-2 dark:hover:bg-surface-2-dark transition-colors">
            <div>
              <p class="text-sm text-slate-600 dark:text-slate-300">{{ t('settings.show_trending_desc') }}</p>
            </div>
            <span class="relative inline-flex shrink-0">
              <input
                type="checkbox"
                :checked="uiStore.showTrending"
                @change="uiStore.setShowTrending(!uiStore.showTrending)"
                class="peer sr-only"
              />
              <span class="h-6 w-11 rounded-full bg-slate-300 transition-colors peer-checked:bg-linear-to-r peer-checked:from-brand-600 peer-checked:to-violet-600 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-400 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-white dark:bg-slate-600 dark:peer-focus-visible:ring-offset-surface-dark"></span>
              <span class="pointer-events-none absolute left-1 top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5"></span>
            </span>
          </label>
        </div>

        <hr class="sb-divider" />

        <!-- Columns (server-synced) -->
        <div>
          <div class="flex items-center gap-2 mb-1">
            <h3 class="sb-label mb-0">{{ t('settings.columns') }}</h3>
            <span class="sb-chip text-[11px]">{{ t('settings.synced_hint') }}</span>
          </div>
          <p class="text-xs text-slate-500 dark:text-slate-400 mb-3">{{ t('settings.columns_desc') }}</p>

          <!-- Active columns list -->
          <div v-if="uiStore.columns.length > 0" class="space-y-1.5 mb-4">
            <div
              v-for="(col, index) in uiStore.columns"
              :key="`col-${index}`"
              class="flex items-center gap-2 px-3 py-2 bg-surface-2 dark:bg-surface-2-dark rounded-xl"
            >
              <span class="flex-1 text-sm font-medium text-slate-700 dark:text-slate-200">
                {{ columnLabel(col) }}
              </span>
              <button
                @click="moveColumnUp(index)"
                :disabled="index === 0"
                class="p-1.5 rounded-lg text-slate-400 transition-colors hover:bg-surface hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed dark:hover:bg-surface-dark dark:hover:text-slate-200"
                :aria-label="t('common.move_up')"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />
                </svg>
              </button>
              <button
                @click="moveColumnDown(index)"
                :disabled="index === uiStore.columns.length - 1"
                class="p-1.5 rounded-lg text-slate-400 transition-colors hover:bg-surface hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed dark:hover:bg-surface-dark dark:hover:text-slate-200"
                :aria-label="t('common.move_down')"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              <button
                @click="uiStore.removeColumnAt(index)"
                class="p-1.5 rounded-lg text-red-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-300"
                :aria-label="t('common.remove')"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          <!-- Add column buttons -->
          <div class="flex flex-wrap gap-2">
            <button
              v-for="col in availableColumns"
              :key="col.type"
              @click="uiStore.addColumn(col.type)"
              class="sb-btn sb-btn-secondary sb-btn-sm"
            >
              + {{ t(col.labelKey) }}
            </button>
          </div>
        </div>
      </div>

      <!-- Clear Cache -->
      <div class="sb-card p-6">
        <h3 class="sb-label">{{ t('settings.clear_cache') }}</h3>
        <p class="text-xs text-slate-500 dark:text-slate-400 mb-3">{{ t('settings.clear_cache_desc') }}</p>
        <div class="flex items-center gap-3">
          <button
            @click="clearCache"
            :disabled="clearingCache"
            class="sb-btn sb-btn-danger"
          >
            {{ t('settings.clear_cache_button') }}
          </button>
          <span v-if="cacheClearSuccess" class="text-sm text-green-600 dark:text-green-400">{{ t('settings.clear_cache_done') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
