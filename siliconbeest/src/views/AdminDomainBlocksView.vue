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
  noop: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  silence: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  suspend: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
}
</script>

<template>
  <AdminLayout>
  <div class="w-full">
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white">{{ t('admin.domainBlocks') }}</h1>
      <button
        v-if="!showForm"
        class="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
        @click="openCreateForm"
      >
        {{ t('admin.addDomainBlock') }}
      </button>
    </div>

    <!-- Error -->
    <div v-if="error" class="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
      {{ error }}
    </div>

    <!-- Create/Edit Form -->
    <div v-if="showForm" class="mb-6 p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 space-y-4">
      <h3 class="text-lg font-medium text-gray-900 dark:text-white">
        {{ editingId ? t('admin.editDomainBlock') : t('admin.addDomainBlock') }}
      </h3>

      <div>
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {{ t('admin.domain') }}
        </label>
        <input
          v-model="formDomain"
          type="text"
          placeholder="example.com"
          :disabled="!!editingId"
          class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
        />
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          {{ t('admin.severity') }}
        </label>
        <div class="flex gap-4">
          <label
            v-for="sev in severities"
            :key="sev.value"
            class="flex items-center gap-2 cursor-pointer"
          >
            <input
              v-model="formSeverity"
              type="radio"
              :value="sev.value"
              class="text-indigo-600 focus:ring-indigo-500"
            />
            <span class="text-sm text-gray-700 dark:text-gray-300">{{ t(sev.labelKey) }}</span>
          </label>
        </div>
      </div>

      <div class="space-y-3">
        <label class="flex items-center gap-3 cursor-pointer">
          <input
            v-model="formRejectMedia"
            type="checkbox"
            class="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
          />
          <span class="text-sm text-gray-700 dark:text-gray-300">{{ t('admin.rejectMedia') }}</span>
        </label>
        <label class="flex items-center gap-3 cursor-pointer">
          <input
            v-model="formRejectReports"
            type="checkbox"
            class="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
          />
          <span class="text-sm text-gray-700 dark:text-gray-300">{{ t('admin.rejectReports') }}</span>
        </label>
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {{ t('admin.privateComment') }}
        </label>
        <textarea
          v-model="formComment"
          rows="2"
          class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
        />
      </div>

      <div class="flex gap-2">
        <button
          :disabled="formSaving || !formDomain.trim()"
          class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          @click="saveBlock"
        >
          {{ formSaving ? t('common.loading') : t('common.save') }}
        </button>
        <button
          class="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          @click="cancelForm"
        >
          {{ t('common.cancel') }}
        </button>
      </div>
    </div>

    <LoadingSpinner v-if="loading" />

    <div v-else-if="blocks.length === 0 && !showForm" class="text-center py-12 text-gray-500 dark:text-gray-400">
      <p>{{ t('admin.noDomainBlocks') }}</p>
    </div>

    <div v-else class="space-y-3">
      <div
        v-for="block in blocks"
        :key="block.id"
        class="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
      >
        <div class="flex items-center justify-between">
          <div>
            <div class="flex items-center gap-2 mb-1">
              <span class="font-medium text-gray-900 dark:text-white">{{ block.domain }}</span>
              <span
                class="px-2 py-0.5 rounded-full text-xs font-medium"
                :class="severityColors[block.severity]"
              >
                {{ t(`admin.severity${block.severity.charAt(0).toUpperCase() + block.severity.slice(1)}`) }}
              </span>
            </div>
            <div class="flex gap-3 text-xs text-gray-500 dark:text-gray-400">
              <span v-if="block.reject_media">{{ t('admin.rejectMedia') }}</span>
              <span v-if="block.reject_reports">{{ t('admin.rejectReports') }}</span>
            </div>
            <p v-if="block.private_comment" class="text-xs text-gray-400 mt-1">
              {{ block.private_comment }}
            </p>
          </div>
          <div class="flex gap-2">
            <button
              class="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              @click="openEditForm(block)"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
              </svg>
            </button>
            <button
              class="p-1.5 text-gray-400 hover:text-red-500 dark:hover:text-red-400"
              @click="deleteBlock(block.id)"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
