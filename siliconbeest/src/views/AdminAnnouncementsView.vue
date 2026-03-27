<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { apiFetch } from '@/api/client'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import AdminLayout from '@/components/layout/AdminLayout.vue'

interface AdminAnnouncement {
  id: string
  text: string
  starts_at: string | null
  ends_at: string | null
  all_day: boolean
  published: boolean
  published_at: string | null
  updated_at: string
}

const { t } = useI18n()
const authStore = useAuthStore()

const loading = ref(false)
const error = ref<string | null>(null)
const announcements = ref<AdminAnnouncement[]>([])

// Form state
const showForm = ref(false)
const editingId = ref<string | null>(null)
const formText = ref('')
const formStartsAt = ref('')
const formEndsAt = ref('')
const formAllDay = ref(false)
const formSaving = ref(false)

onMounted(() => {
  loadAnnouncements()
})

async function loadAnnouncements() {
  loading.value = true
  error.value = null
  try {
    const { data } = await apiFetch<AdminAnnouncement[]>('/v1/admin/announcements', {
      token: authStore.token ?? undefined,
    })
    announcements.value = data
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

function openCreateForm() {
  editingId.value = null
  formText.value = ''
  formStartsAt.value = ''
  formEndsAt.value = ''
  formAllDay.value = false
  showForm.value = true
}

function openEditForm(a: AdminAnnouncement) {
  editingId.value = a.id
  formText.value = a.text
  formStartsAt.value = a.starts_at ? a.starts_at.slice(0, 16) : ''
  formEndsAt.value = a.ends_at ? a.ends_at.slice(0, 16) : ''
  formAllDay.value = a.all_day
  showForm.value = true
}

function cancelForm() {
  showForm.value = false
  editingId.value = null
}

async function saveAnnouncement() {
  formSaving.value = true
  error.value = null

  try {
    const body: Record<string, unknown> = {
      text: formText.value,
      all_day: formAllDay.value,
    }
    if (formStartsAt.value) body.starts_at = new Date(formStartsAt.value).toISOString()
    if (formEndsAt.value) body.ends_at = new Date(formEndsAt.value).toISOString()

    if (editingId.value) {
      await apiFetch(`/v1/admin/announcements/${editingId.value}`, {
        method: 'PUT',
        token: authStore.token ?? undefined,
        body: JSON.stringify(body),
      })
    } else {
      await apiFetch('/v1/admin/announcements', {
        method: 'POST',
        token: authStore.token ?? undefined,
        body: JSON.stringify(body),
      })
    }

    showForm.value = false
    editingId.value = null
    await loadAnnouncements()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    formSaving.value = false
  }
}

async function deleteAnnouncement(id: string) {
  if (!confirm(t('admin.deleteAnnouncementConfirm'))) return

  try {
    await apiFetch(`/v1/admin/announcements/${id}`, {
      method: 'DELETE',
      token: authStore.token ?? undefined,
    })
    await loadAnnouncements()
  } catch (e) {
    error.value = (e as Error).message
  }
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
</script>

<template>
  <AdminLayout>
  <div class="w-full">
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white">{{ t('admin.announcements') }}</h1>
      <button
        v-if="!showForm"
        class="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
        @click="openCreateForm"
      >
        {{ t('admin.addAnnouncement') }}
      </button>
    </div>

    <!-- Error -->
    <div v-if="error" class="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
      {{ error }}
    </div>

    <!-- Create/Edit Form -->
    <div v-if="showForm" class="mb-6 p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 space-y-4">
      <h3 class="text-lg font-medium text-gray-900 dark:text-white">
        {{ editingId ? t('admin.editAnnouncement') : t('admin.addAnnouncement') }}
      </h3>

      <div>
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {{ t('admin.announcementText') }}
        </label>
        <textarea
          v-model="formText"
          rows="4"
          class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
        />
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {{ t('admin.startsAt') }}
          </label>
          <input
            v-model="formStartsAt"
            type="datetime-local"
            class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {{ t('admin.endsAt') }}
          </label>
          <input
            v-model="formEndsAt"
            type="datetime-local"
            class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
      </div>

      <label class="flex items-center gap-3 cursor-pointer">
        <input
          v-model="formAllDay"
          type="checkbox"
          class="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
        />
        <span class="text-sm text-gray-700 dark:text-gray-300">{{ t('admin.allDay') }}</span>
      </label>

      <div class="flex gap-2">
        <button
          :disabled="formSaving || !formText.trim()"
          class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          @click="saveAnnouncement"
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

    <div v-else-if="announcements.length === 0 && !showForm" class="text-center py-12 text-gray-500 dark:text-gray-400">
      <p>{{ t('admin.noAnnouncements') }}</p>
    </div>

    <div v-else class="space-y-4">
      <div
        v-for="a in announcements"
        :key="a.id"
        class="p-5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
      >
        <div class="flex items-start justify-between">
          <div class="flex-1">
            <p class="text-sm text-gray-900 dark:text-white whitespace-pre-wrap" v-html="a.text" />
            <div class="flex gap-4 mt-2 text-xs text-gray-500 dark:text-gray-400">
              <span v-if="a.starts_at">{{ t('admin.startsAt') }}: {{ formatDate(a.starts_at) }}</span>
              <span v-if="a.ends_at">{{ t('admin.endsAt') }}: {{ formatDate(a.ends_at) }}</span>
              <span v-if="a.all_day" class="px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
                {{ t('admin.allDay') }}
              </span>
            </div>
          </div>
          <div class="flex gap-2 ml-4">
            <button
              class="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              @click="openEditForm(a)"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
              </svg>
            </button>
            <button
              class="p-1.5 text-gray-400 hover:text-red-500 dark:hover:text-red-400"
              @click="deleteAnnouncement(a.id)"
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
