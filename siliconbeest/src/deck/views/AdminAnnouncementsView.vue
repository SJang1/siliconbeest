<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { apiFetch } from '@/api/client'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import DeckAdminLayout from '@/deck/layout/DeckAdminLayout.vue'

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
  <DeckAdminLayout>
  <div class="w-full max-w-5xl animate-fade-in">
    <div class="mb-6 flex items-center justify-between">
      <h1 class="sb-heading text-2xl text-slate-900 dark:text-white">{{ t('admin.announcements') }}</h1>
      <button
        v-if="!showForm"
        class="sb-btn sb-btn-primary"
        @click="openCreateForm"
      >
        {{ t('admin.addAnnouncement') }}
      </button>
    </div>

    <!-- Error -->
    <div v-if="error" class="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
      {{ error }}
    </div>

    <!-- Create/Edit Form -->
    <div v-if="showForm" class="sb-card mb-6 space-y-4 p-6 animate-rise-in">
      <h3 class="sb-heading text-lg text-slate-900 dark:text-white">
        {{ editingId ? t('admin.editAnnouncement') : t('admin.addAnnouncement') }}
      </h3>

      <div>
        <label class="sb-label">
          {{ t('admin.announcementText') }}
        </label>
        <textarea
          v-model="formText"
          rows="4"
          class="sb-input resize-none"
        />
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="sb-label">
            {{ t('admin.startsAt') }}
          </label>
          <input
            v-model="formStartsAt"
            type="datetime-local"
            class="sb-input"
          />
        </div>
        <div>
          <label class="sb-label">
            {{ t('admin.endsAt') }}
          </label>
          <input
            v-model="formEndsAt"
            type="datetime-local"
            class="sb-input"
          />
        </div>
      </div>

      <label class="flex cursor-pointer items-center gap-3">
        <input
          v-model="formAllDay"
          type="checkbox"
          class="h-4 w-4 rounded accent-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:accent-brand-500"
        />
        <span class="text-sm text-slate-700 dark:text-slate-300">{{ t('admin.allDay') }}</span>
      </label>

      <div class="flex gap-2">
        <button
          :disabled="formSaving || !formText.trim()"
          class="sb-btn sb-btn-primary"
          @click="saveAnnouncement"
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

    <div v-else-if="announcements.length === 0 && !showForm" class="sb-card">
      <div class="sb-empty">
        <p>{{ t('admin.noAnnouncements') }}</p>
      </div>
    </div>

    <div v-else class="space-y-4">
      <div
        v-for="a in announcements"
        :key="a.id"
        class="sb-card p-5"
      >
        <div class="flex items-start justify-between">
          <div class="flex-1">
            <p class="whitespace-pre-wrap text-sm text-slate-900 dark:text-white">{{ a.text }}</p>
            <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
              <span v-if="a.starts_at">{{ t('admin.startsAt') }}: {{ formatDate(a.starts_at) }}</span>
              <span v-if="a.ends_at">{{ t('admin.endsAt') }}: {{ formatDate(a.ends_at) }}</span>
              <span v-if="a.all_day" class="sb-chip bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300">
                {{ t('admin.allDay') }}
              </span>
            </div>
          </div>
          <div class="ml-4 flex gap-1">
            <button
              class="rounded-full p-2 text-slate-400 transition-colors hover:bg-surface-2 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:hover:bg-surface-2-dark dark:hover:text-slate-200"
              @click="openEditForm(a)"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
              </svg>
            </button>
            <button
              class="rounded-full p-2 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:hover:bg-red-950/40 dark:hover:text-red-400"
              @click="deleteAnnouncement(a.id)"
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
  </DeckAdminLayout>
</template>
