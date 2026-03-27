<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { apiFetch, apiFetchFormData } from '@/api/client'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()
const authStore = useAuthStore()

// --- Section 1: Account Aliases ---
const aliases = ref<{ acct: string }[]>([])
const aliasInput = ref('')
const aliasLoading = ref(false)
const aliasError = ref<string | null>(null)

async function fetchAliases() {
  aliasLoading.value = true
  aliasError.value = null
  try {
    const { data } = await apiFetch<{ acct: string }[]>('/v1/accounts/aliases', {
      token: authStore.token ?? undefined,
    })
    aliases.value = data
  } catch (e) {
    aliasError.value = (e as Error).message
  } finally {
    aliasLoading.value = false
  }
}

async function addAlias() {
  if (!aliasInput.value.trim()) return
  aliasError.value = null
  try {
    await apiFetch('/v1/accounts/aliases', {
      token: authStore.token ?? undefined,
      method: 'POST',
      body: JSON.stringify({ acct: aliasInput.value.trim() }),
    })
    aliasInput.value = ''
    await fetchAliases()
  } catch (e) {
    aliasError.value = (e as Error).message
  }
}

async function removeAlias(acct: string) {
  aliasError.value = null
  try {
    await apiFetch('/v1/accounts/aliases', {
      token: authStore.token ?? undefined,
      method: 'DELETE',
      body: JSON.stringify({ acct }),
    })
    await fetchAliases()
  } catch (e) {
    aliasError.value = (e as Error).message
  }
}

// --- Section 2: Account Migration ---
const moveTarget = ref('')
const moveConfirmed = ref(false)
const moveLoading = ref(false)
const moveError = ref<string | null>(null)
const moveSuccess = ref(false)

async function moveAccount() {
  if (!moveConfirmed.value || !moveTarget.value.trim()) return
  moveLoading.value = true
  moveError.value = null
  moveSuccess.value = false
  try {
    await apiFetch('/v1/accounts/migration', {
      token: authStore.token ?? undefined,
      method: 'POST',
      body: JSON.stringify({ target_acct: moveTarget.value.trim() }),
    })
    moveSuccess.value = true
  } catch (e) {
    moveError.value = (e as Error).message
  } finally {
    moveLoading.value = false
  }
}

// --- Section 3: Data Export ---
const exportTypes = [
  { key: 'following', endpoint: '/v1/export/following.csv' },
  { key: 'followers', endpoint: '/v1/export/followers.csv' },
  { key: 'blocks', endpoint: '/v1/export/blocks.csv' },
  { key: 'mutes', endpoint: '/v1/export/mutes.csv' },
  { key: 'bookmarks', endpoint: '/v1/export/bookmarks.csv' },
  { key: 'lists', endpoint: '/v1/export/lists.csv' },
]

async function downloadExport(endpoint: string, filename: string) {
  try {
    const res = await fetch(`/api${endpoint}`, {
      headers: {
        Authorization: `Bearer ${authStore.token}`,
      },
    })
    if (!res.ok) throw new Error(res.statusText)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } catch (e) {
    console.error('Export failed:', e)
  }
}

// --- Section 4: Data Import ---
const importType = ref('following')
const importFile = ref<File | null>(null)
const importLoading = ref(false)
const importError = ref<string | null>(null)
const importSuccess = ref(false)

const importTypes = [
  { value: 'following', labelKey: 'migration.export_following' },
  { value: 'blocks', labelKey: 'migration.export_blocks' },
  { value: 'mutes', labelKey: 'migration.export_mutes' },
]

function onImportFileChange(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) {
    importFile.value = file
  }
}

async function startImport() {
  if (!importFile.value) return
  importLoading.value = true
  importError.value = null
  importSuccess.value = false
  try {
    const formData = new FormData()
    formData.append('type', importType.value)
    formData.append('data', importFile.value)
    await apiFetchFormData('/v1/import', formData, {
      token: authStore.token ?? undefined,
    })
    importSuccess.value = true
    importFile.value = null
  } catch (e) {
    importError.value = (e as Error).message
  } finally {
    importLoading.value = false
  }
}

onMounted(() => {
  fetchAliases()
})
</script>

<template>
  <div class="w-full p-4 md:p-6 space-y-8">
    <h2 class="text-xl font-bold text-gray-900 dark:text-white">{{ t('migration.title') }}</h2>

    <!-- Section 1: Account Aliases -->
    <section class="space-y-4">
      <h3 class="text-lg font-semibold text-gray-900 dark:text-white">{{ t('migration.aliases') }}</h3>
      <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('migration.aliases_hint') }}</p>

      <LoadingSpinner v-if="aliasLoading" />

      <div v-else class="space-y-2">
        <div
          v-for="alias in aliases"
          :key="alias.acct"
          class="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700"
        >
          <span class="text-sm text-gray-900 dark:text-white">{{ alias.acct }}</span>
          <button
            type="button"
            class="text-sm text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
            @click="removeAlias(alias.acct)"
          >
            {{ t('migration.remove_alias') }}
          </button>
        </div>

        <div v-if="aliases.length === 0" class="text-sm text-gray-400 dark:text-gray-500">
          {{ t('migration.aliases_hint') }}
        </div>
      </div>

      <form class="flex gap-2" @submit.prevent="addAlias">
        <input
          v-model="aliasInput"
          type="text"
          placeholder="@user@domain"
          class="flex-1 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <button
          type="submit"
          class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
        >
          {{ t('migration.add_alias') }}
        </button>
      </form>

      <div v-if="aliasError" class="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
        {{ aliasError }}
      </div>
    </section>

    <hr class="border-gray-200 dark:border-gray-700" />

    <!-- Section 2: Account Migration -->
    <section class="space-y-4">
      <h3 class="text-lg font-semibold text-gray-900 dark:text-white">{{ t('migration.move_account') }}</h3>

      <div class="p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
        <p class="text-sm text-red-700 dark:text-red-400 font-medium">{{ t('migration.move_warning') }}</p>
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {{ t('migration.target_acct') }}
        </label>
        <input
          v-model="moveTarget"
          type="text"
          placeholder="@user@domain"
          class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>

      <label class="flex items-center gap-3 cursor-pointer">
        <input
          v-model="moveConfirmed"
          type="checkbox"
          class="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-red-600 focus:ring-red-500"
        />
        <span class="text-sm text-gray-700 dark:text-gray-300">{{ t('migration.confirm_move') }}</span>
      </label>

      <button
        type="button"
        :disabled="!moveConfirmed || !moveTarget.trim() || moveLoading"
        class="w-full px-4 py-2 rounded-lg bg-red-600 text-white font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        @click="moveAccount"
      >
        {{ moveLoading ? t('common.loading') : t('migration.move_account') }}
      </button>

      <div v-if="moveError" class="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
        {{ moveError }}
      </div>
      <div v-if="moveSuccess" class="p-3 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 text-sm">
        {{ t('settings.saved') }}
      </div>
    </section>

    <hr class="border-gray-200 dark:border-gray-700" />

    <!-- Section 3: Data Export -->
    <section class="space-y-4">
      <h3 class="text-lg font-semibold text-gray-900 dark:text-white">{{ t('migration.export') }}</h3>

      <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <button
          v-for="exp in exportTypes"
          :key="exp.key"
          type="button"
          class="px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          @click="downloadExport(exp.endpoint, `${exp.key}.csv`)"
        >
          {{ t(`migration.export_${exp.key}`) }}
        </button>
      </div>
    </section>

    <hr class="border-gray-200 dark:border-gray-700" />

    <!-- Section 4: Data Import -->
    <section class="space-y-4">
      <h3 class="text-lg font-semibold text-gray-900 dark:text-white">{{ t('migration.import') }}</h3>

      <div>
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {{ t('migration.import_type') }}
        </label>
        <select
          v-model="importType"
          class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option v-for="it in importTypes" :key="it.value" :value="it.value">
            {{ t(it.labelKey) }}
          </option>
        </select>
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {{ t('migration.import_file') }}
        </label>
        <input
          type="file"
          accept=".csv"
          class="text-sm text-gray-600 dark:text-gray-400 file:mr-2 file:py-1 file:px-3 file:rounded-lg file:border-0 file:text-sm file:bg-indigo-50 file:text-indigo-700 dark:file:bg-indigo-900/30 dark:file:text-indigo-400 hover:file:bg-indigo-100"
          @change="onImportFileChange"
        />
      </div>

      <button
        type="button"
        :disabled="!importFile || importLoading"
        class="w-full px-4 py-2 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        @click="startImport"
      >
        {{ importLoading ? t('migration.import_processing') : t('migration.import_start') }}
      </button>

      <div v-if="importError" class="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
        {{ importError }}
      </div>
      <div v-if="importSuccess" class="p-3 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 text-sm">
        {{ t('migration.import_success') }}
      </div>
    </section>
  </div>
</template>
