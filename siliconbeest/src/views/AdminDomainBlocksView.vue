<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { apiFetch } from '@/api/client'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import AdminLayout from '@/components/layout/AdminLayout.vue'

interface DomainBlock {
  id: string
  domain: string
  digest: string
  severity: 'silence' | 'suspend' | 'noop'
  reject_media: boolean
  reject_reports: boolean
  private_comment: string | null
  public_comment: string | null
  obfuscate: boolean
  created_at: string
}

const { t } = useI18n()
const authStore = useAuthStore()

const loading = ref(false)
const error = ref<string | null>(null)
const blocks = ref<DomainBlock[]>([])

// Form state
const showForm = ref(false)
const editingId = ref<string | null>(null)
const formDomain = ref('')
const formSeverity = ref<'silence' | 'suspend' | 'noop'>('silence')
const formRejectMedia = ref(false)
const formRejectReports = ref(false)
const formComment = ref('')
const formSaving = ref(false)

const severities: { value: 'silence' | 'suspend' | 'noop'; labelKey: string }[] = [
  { value: 'noop', labelKey: 'admin.severityNoop' },
  { value: 'silence', labelKey: 'admin.severitySilence' },
  { value: 'suspend', labelKey: 'admin.severitySuspend' },
]

onMounted(() => {
  loadBlocks()
})

async function loadBlocks() {
  loading.value = true
  error.value = null
  try {
    const { data } = await apiFetch<DomainBlock[]>('/v1/admin/domain_blocks', {
      token: authStore.token ?? undefined,
    })
    blocks.value = data
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

function openCreateForm() {
  editingId.value = null
  formDomain.value = ''
  formSeverity.value = 'silence'
  formRejectMedia.value = false
  formRejectReports.value = false
  formComment.value = ''
  showForm.value = true
}

function openEditForm(block: DomainBlock) {
  editingId.value = block.id
  formDomain.value = block.domain
  formSeverity.value = block.severity
  formRejectMedia.value = block.reject_media
  formRejectReports.value = block.reject_reports
  formComment.value = block.private_comment ?? ''
  showForm.value = true
}

function cancelForm() {
  showForm.value = false
  editingId.value = null
}

async function saveBlock() {
  formSaving.value = true
  error.value = null

  try {
    const body = {
      domain: formDomain.value,
      severity: formSeverity.value,
      reject_media: formRejectMedia.value,
      reject_reports: formRejectReports.value,
      private_comment: formComment.value || null,
    }

    if (editingId.value) {
      await apiFetch(`/v1/admin/domain_blocks/${editingId.value}`, {
        method: 'PUT',
        token: authStore.token ?? undefined,
        body: JSON.stringify(body),
      })
    } else {
      await apiFetch('/v1/admin/domain_blocks', {
        method: 'POST',
        token: authStore.token ?? undefined,
        body: JSON.stringify(body),
      })
    }

    showForm.value = false
    editingId.value = null
    await loadBlocks()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    formSaving.value = false
  }
}

async function deleteBlock(id: string) {
  if (!confirm(t('admin.deleteDomainBlockConfirm'))) return

  try {
    await apiFetch(`/v1/admin/domain_blocks/${id}`, {
      method: 'DELETE',
      token: authStore.token ?? undefined,
    })
    await loadBlocks()
  } catch (e) {
    error.value = (e as Error).message
  }
}

const severityColors: Record<string, string> = {
  noop: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  silence: 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  suspend: 'bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300',
}
</script>

<template>
  <AdminLayout>
  <div class="w-full max-w-5xl animate-fade-in">
    <div class="mb-6 flex items-center justify-between">
      <h1 class="sb-heading text-2xl text-slate-900 dark:text-white">{{ t('admin.domainBlocks') }}</h1>
      <button
        v-if="!showForm"
        class="sb-btn sb-btn-primary"
        @click="openCreateForm"
      >
        {{ t('admin.addDomainBlock') }}
      </button>
    </div>

    <!-- Error -->
    <div v-if="error" class="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
      {{ error }}
    </div>

    <!-- Create/Edit Form -->
    <div v-if="showForm" class="sb-card mb-6 space-y-4 p-6 animate-rise-in">
      <h3 class="sb-heading text-lg text-slate-900 dark:text-white">
        {{ editingId ? t('admin.editDomainBlock') : t('admin.addDomainBlock') }}
      </h3>

      <div>
        <label class="sb-label">
          {{ t('admin.domain') }}
        </label>
        <input
          v-model="formDomain"
          type="text"
          placeholder="example.com"
          :disabled="!!editingId"
          class="sb-input disabled:opacity-50"
        />
      </div>

      <div>
        <label class="sb-label mb-2">
          {{ t('admin.severity') }}
        </label>
        <div class="flex gap-4">
          <label
            v-for="sev in severities"
            :key="sev.value"
            class="flex cursor-pointer items-center gap-2"
          >
            <input
              v-model="formSeverity"
              type="radio"
              :value="sev.value"
              class="h-4 w-4 accent-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:accent-brand-500"
            />
            <span class="text-sm text-slate-700 dark:text-slate-300">{{ t(sev.labelKey) }}</span>
          </label>
        </div>
      </div>

      <div class="space-y-3">
        <label class="flex cursor-pointer items-center gap-3">
          <input
            v-model="formRejectMedia"
            type="checkbox"
            class="h-4 w-4 rounded accent-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:accent-brand-500"
          />
          <span class="text-sm text-slate-700 dark:text-slate-300">{{ t('admin.rejectMedia') }}</span>
        </label>
        <label class="flex cursor-pointer items-center gap-3">
          <input
            v-model="formRejectReports"
            type="checkbox"
            class="h-4 w-4 rounded accent-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:accent-brand-500"
          />
          <span class="text-sm text-slate-700 dark:text-slate-300">{{ t('admin.rejectReports') }}</span>
        </label>
      </div>

      <div>
        <label class="sb-label">
          {{ t('admin.privateComment') }}
        </label>
        <textarea
          v-model="formComment"
          rows="2"
          class="sb-input resize-none"
        />
      </div>

      <div class="flex gap-2">
        <button
          :disabled="formSaving || !formDomain.trim()"
          class="sb-btn sb-btn-primary"
          @click="saveBlock"
        >
          {{ formSaving ? t('common.loading') : t('common.save') }}
        </button>
        <button
          class="sb-btn sb-btn-secondary"
          @click="cancelForm"
        >
          {{ t('common.cancel') }}
        </button>
      </div>
    </div>

    <LoadingSpinner v-if="loading" />

    <div v-else-if="blocks.length === 0 && !showForm" class="sb-card">
      <div class="sb-empty">
        <p>{{ t('admin.noDomainBlocks') }}</p>
      </div>
    </div>

    <div v-else class="sb-card divide-y divide-outline overflow-hidden dark:divide-outline-dark">
      <div
        v-for="block in blocks"
        :key="block.id"
        class="p-4 transition-colors hover:bg-surface-2/70 dark:hover:bg-surface-2-dark/70"
      >
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="mb-1 flex items-center gap-2">
              <span class="truncate font-medium text-slate-900 dark:text-white">{{ block.domain }}</span>
              <span
                class="sb-chip shrink-0"
                :class="severityColors[block.severity]"
              >
                {{ t(`admin.severity${block.severity.charAt(0).toUpperCase() + block.severity.slice(1)}`) }}
              </span>
            </div>
            <div class="flex gap-3 text-xs text-slate-500 dark:text-slate-400">
              <span v-if="block.reject_media">{{ t('admin.rejectMedia') }}</span>
              <span v-if="block.reject_reports">{{ t('admin.rejectReports') }}</span>
            </div>
            <p v-if="block.private_comment" class="mt-1 text-xs text-slate-400 dark:text-slate-500">
              {{ block.private_comment }}
            </p>
          </div>
          <div class="flex shrink-0 gap-1">
            <button
              class="rounded-full p-2 text-slate-400 transition-colors hover:bg-surface-2 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:hover:bg-surface-2-dark dark:hover:text-slate-200"
              @click="openEditForm(block)"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
              </svg>
            </button>
            <button
              class="rounded-full p-2 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:hover:bg-red-950/40 dark:hover:text-red-400"
              @click="deleteBlock(block.id)"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
  </AdminLayout>
</template>
