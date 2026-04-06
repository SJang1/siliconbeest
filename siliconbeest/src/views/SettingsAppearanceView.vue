<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUiStore, type Theme, type ColumnType } from '@/stores/ui'
import { useAuthStore } from '@/stores/auth'
import { updateCredentials } from '@/api/mastodon/accounts'
import LanguageSelector from '@/components/settings/LanguageSelector.vue'
import { SUPPORTED_LOCALES } from '@/i18n'

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

const localeMap = Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l.code, l.name]))

const availableColumns: { type: ColumnType; labelKey: string }[] = [
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

watch(() => auth.currentUser?.source?.language, (lang) => {
  if (lang) defaultLanguage.value = lang
}, { immediate: true })
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

      <!-- Display Language (client-side, localStorage) -->
      <div>
        <h3 class="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ t('settings.display_language') }}</h3>
        <p class="text-xs text-gray-500 dark:text-gray-400 mb-2">{{ t('settings.display_language_desc') }}</p>
        <LanguageSelector />
      </div>

      <!-- Default Language (server-side, users.locale) -->
      <div>
        <h3 class="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ t('settings.default_language') }}</h3>
        <p class="text-xs text-gray-500 dark:text-gray-400 mb-2">{{ t('settings.default_language_desc') }}</p>
        <div class="flex items-center gap-3">
          <select
            :value="defaultLanguage"
            @change="saveDefaultLanguage(($event.target as HTMLSelectElement).value)"
            :disabled="savingDefaultLang"
            class="w-full max-w-xs px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
          >
            <option v-for="loc in SUPPORTED_LOCALES" :key="loc.code" :value="loc.code">
              {{ loc.name }}
            </option>
          </select>
          <span v-if="defaultLangSuccess" class="text-sm text-green-600 dark:text-green-400">{{ t('settings.saved') }}</span>
        </div>
      </div>
      <!-- Trending Panel -->
      <div>
        <label class="flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
          <input
            type="checkbox"
            :checked="uiStore.showTrending"
            @change="uiStore.setShowTrending(!uiStore.showTrending)"
            class="w-4 h-4 text-indigo-600 bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 rounded focus:ring-indigo-500"
          />
          <div>
            <span class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ t('settings.show_trending') }}</span>
            <p class="text-xs text-gray-500 dark:text-gray-400">{{ t('settings.show_trending_desc') }}</p>
          </div>
        </label>
      </div>

      <!-- Columns -->
      <div>
        <h3 class="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ t('settings.columns') }}</h3>
        <p class="text-xs text-gray-500 dark:text-gray-400 mb-3">{{ t('settings.columns_desc') }}</p>

        <!-- Active columns list -->
        <div v-if="uiStore.columns.length > 0" class="space-y-1 mb-4">
          <div
            v-for="(col, index) in uiStore.columns"
            :key="`col-${index}`"
            class="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-800 rounded-lg"
          >
            <span class="flex-1 text-sm text-gray-700 dark:text-gray-300">
              {{ columnLabel(col) }}
            </span>
            <button
              @click="moveColumnUp(index)"
              :disabled="index === 0"
              class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label="Move up"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />
              </svg>
            </button>
            <button
              @click="moveColumnDown(index)"
              :disabled="index === uiStore.columns.length - 1"
              class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label="Move down"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            <button
              @click="uiStore.removeColumnAt(index)"
              class="p-1 text-red-400 hover:text-red-600 dark:hover:text-red-300"
              aria-label="Remove"
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
            class="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            + {{ t(col.labelKey) }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
