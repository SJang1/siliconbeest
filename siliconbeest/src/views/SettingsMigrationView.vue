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
  <div class="w-full space-y-6">
    <h2 class="sb-heading text-xl">{{ t('migration.title') }}</h2>

    <!-- Section 1: Account Aliases -->
    <section class="sb-card p-6 space-y-4">
      <h3 class="sb-heading text-lg">{{ t('migration.aliases') }}</h3>
      <p class="text-sm text-slate-500 dark:text-slate-400">{{ t('migration.aliases_hint') }}</p>

      <LoadingSpinner v-if="aliasLoading" />

      <div v-else class="space-y-2">
        <div
          v-for="alias in aliases"
          :key="alias.acct"
          class="flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-surface-2 dark:bg-surface-2-dark"
        >
          <span class="text-sm font-medium text-slate-900 dark:text-slate-100">{{ alias.acct }}</span>
          <button
            type="button"
            class="text-sm font-medium text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 transition-colors"
            @click="removeAlias(alias.acct)"
          >
            {{ t('migration.remove_alias') }}
          </button>
        </div>

        <div v-if="aliases.length === 0" class="text-sm text-slate-400 dark:text-slate-500">
          {{ t('migration.aliases_hint') }}
        </div>
      </div>

      <form class="flex gap-2" @submit.prevent="addAlias">
        <input
          v-model="aliasInput"
          type="text"
          placeholder="@user@domain"
          class="sb-input flex-1"
        />
        <button
          type="submit"
          class="sb-btn sb-btn-primary shrink-0"
        >
          {{ t('migration.add_alias') }}
        </button>
      </form>

      <div v-if="aliasError" class="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-sm">
        {{ aliasError }}
      </div>
    </section>

    <!-- Section 2: Account Migration -->
    <section class="sb-card p-6 space-y-4 border-red-200 dark:border-red-900/60">
      <h3 class="sb-heading text-lg">{{ t('migration.move_account') }}</h3>

      <div class="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900">
        <p class="text-sm text-red-700 dark:text-red-400 font-medium">{{ t('migration.move_warning') }}</p>
      </div>

      <div>
        <label class="sb-label">
          {{ t('migration.target_acct') }}
        </label>
        <input
          v-model="moveTarget"
          type="text"
          placeholder="@user@domain"
          class="sb-input"
        />
      </div>

      <label class="flex items-center gap-3 cursor-pointer">
        <input
          v-model="moveConfirmed"
          type="checkbox"
          class="w-4 h-4 rounded border-outline text-red-600 focus:ring-red-500 dark:border-outline-dark dark:bg-surface-2-dark"
        />
        <span class="text-sm text-slate-700 dark:text-slate-200">{{ t('migration.confirm_move') }}</span>
      </label>

      <button
        type="button"
        :disabled="!moveConfirmed || !moveTarget.trim() || moveLoading"
        class="sb-btn sb-btn-danger w-full"
        @click="moveAccount"
      >
        {{ moveLoading ? t('common.loading') : t('migration.move_account') }}
      </button>

      <div v-if="moveError" class="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-sm">
        {{ moveError }}
      </div>
      <div v-if="moveSuccess" class="p-3 rounded-xl bg-green-50 dark:bg-green-950/40 text-green-600 dark:text-green-400 text-sm">
        {{ t('settings.saved') }}
      </div>
    </section>

    <!-- Section 3: Data Export -->
    <section class="sb-card p-6 space-y-4">
      <h3 class="sb-heading text-lg">{{ t('migration.export') }}</h3>

      <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <button
          v-for="exp in exportTypes"
          :key="exp.key"
          type="button"
          class="px-4 py-3 rounded-xl border border-outline bg-surface text-slate-700 text-sm font-medium transition-colors hover:border-brand-300 hover:bg-surface-2 hover:text-slate-900 dark:border-outline-dark dark:bg-surface-dark dark:text-slate-200 dark:hover:border-brand-700 dark:hover:bg-surface-2-dark dark:hover:text-white"
          @click="downloadExport(exp.endpoint, `${exp.key}.csv`)"
        >
          {{ t(`migration.export_${exp.key}`) }}
        </button>
      </div>
    </section>

    <!-- Section 4: Data Import -->
    <section class="sb-card p-6 space-y-4">
      <h3 class="sb-heading text-lg">{{ t('migration.import') }}</h3>

      <div>
        <label class="sb-label">
          {{ t('migration.import_type') }}
        </label>
        <select
          v-model="importType"
          class="sb-input"
        >
          <option v-for="it in importTypes" :key="it.value" :value="it.value">
            {{ t(it.labelKey) }}
          </option>
        </select>
      </div>

      <div>
        <label class="sb-label">
          {{ t('migration.import_file') }}
        </label>
        <input
          type="file"
          accept=".csv"
          class="text-sm text-slate-500 dark:text-slate-400 file:mr-3 file:rounded-full file:border-0 file:px-4 file:py-1.5 file:text-sm file:font-semibold file:bg-brand-50 file:text-brand-700 hover:file:bg-brand-100 dark:file:bg-brand-950/60 dark:file:text-brand-300 dark:hover:file:bg-brand-900/60 file:transition-colors"
          @change="onImportFileChange"
        />
      </div>

      <button
        type="button"
        :disabled="!importFile || importLoading"
        class="sb-btn sb-btn-primary w-full"
        @click="startImport"
      >
        {{ importLoading ? t('migration.import_processing') : t('migration.import_start') }}
      </button>

      <div v-if="importError" class="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-sm">
        {{ importError }}
      </div>
      <div v-if="importSuccess" class="p-3 rounded-xl bg-green-50 dark:bg-green-950/40 text-green-600 dark:text-green-400 text-sm">
        {{ t('migration.import_success') }}
      </div>
    </section>
  </div>
</template>
