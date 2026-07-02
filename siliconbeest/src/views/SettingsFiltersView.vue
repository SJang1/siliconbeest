<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { apiFetch } from '@/api/client'
import type { Filter, FilterContext } from '@/types/mastodon'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()
const authStore = useAuthStore()

const loading = ref(false)
const error = ref<string | null>(null)
const filters = ref<Filter[]>([])

// Form state
const showForm = ref(false)
const editingId = ref<string | null>(null)
const formTitle = ref('')
const formKeywords = ref('')
const formAction = ref<'warn' | 'hide'>('warn')
const formContexts = ref<FilterContext[]>(['home', 'public'])
const formSaving = ref(false)

const allContexts: FilterContext[] = ['home', 'notifications', 'public', 'thread', 'account']

onMounted(() => {
  loadFilters()
})

async function loadFilters() {
  loading.value = true
  error.value = null
  try {
    const { data } = await apiFetch<Filter[]>('/v2/filters', {
      token: authStore.token ?? undefined,
    })
    filters.value = data
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

function openCreateForm() {
  editingId.value = null
  formTitle.value = ''
  formKeywords.value = ''
  formAction.value = 'warn'
  formContexts.value = ['home', 'public']
  showForm.value = true
}

function openEditForm(filter: Filter) {
  editingId.value = filter.id
  formTitle.value = filter.title
  formKeywords.value = filter.keywords.map((k) => k.keyword).join(', ')
  formAction.value = filter.filter_action
  formContexts.value = [...filter.context]
  showForm.value = true
}

function cancelForm() {
  showForm.value = false
  editingId.value = null
}

function toggleContext(ctx: FilterContext) {
  const idx = formContexts.value.indexOf(ctx)
  if (idx >= 0) {
    formContexts.value.splice(idx, 1)
  } else {
    formContexts.value.push(ctx)
  }
}

async function saveFilter() {
  formSaving.value = true
  error.value = null

  try {
    const keywords = formKeywords.value
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0)

    const body = {
      title: formTitle.value,
      context: formContexts.value,
      filter_action: formAction.value,
      keywords_attributes: keywords.map((keyword) => ({
        keyword,
        whole_word: true,
      })),
    }

    if (editingId.value) {
      await apiFetch(`/v2/filters/${editingId.value}`, {
        method: 'PUT',
        token: authStore.token ?? undefined,
        body: JSON.stringify(body),
      })
    } else {
      await apiFetch('/v2/filters', {
        method: 'POST',
        token: authStore.token ?? undefined,
        body: JSON.stringify(body),
      })
    }

    showForm.value = false
    editingId.value = null
    await loadFilters()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    formSaving.value = false
  }
}

async function deleteFilter(id: string) {
  if (!confirm(t('settings.filterDeleteConfirm'))) return

  try {
    await apiFetch(`/v2/filters/${id}`, {
      method: 'DELETE',
      token: authStore.token ?? undefined,
    })
    await loadFilters()
  } catch (e) {
    error.value = (e as Error).message
  }
}
</script>

<template>
  <div class="w-full">
    <div class="flex items-center justify-between mb-6">
      <h2 class="sb-heading text-xl">{{ t('settings.filters') }}</h2>
      <button
        v-if="!showForm"
        class="sb-btn sb-btn-primary sb-btn-sm"
        @click="openCreateForm"
      >
        {{ t('settings.addFilter') }}
      </button>
    </div>

    <!-- Error -->
    <div v-if="error" class="mb-4 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-sm">
      {{ error }}
    </div>

    <!-- Create/Edit Form -->
    <div v-if="showForm" class="sb-card mb-6 p-6 space-y-4 animate-rise-in">
      <h3 class="sb-heading text-lg">
        {{ editingId ? t('settings.editFilter') : t('settings.addFilter') }}
      </h3>

      <div>
        <label class="sb-label">
          {{ t('settings.filterTitle') }}
        </label>
        <input
          v-model="formTitle"
          type="text"
          class="sb-input"
        />
      </div>

      <div>
        <label class="sb-label">
          {{ t('settings.filterKeywords') }}
        </label>
        <input
          v-model="formKeywords"
          type="text"
          :placeholder="t('settings.filterKeywordsHint')"
          class="sb-input"
        />
      </div>

      <div>
        <label class="sb-label">
          {{ t('settings.filterContext') }}
        </label>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="ctx in allContexts"
            :key="ctx"
            type="button"
            class="px-3 py-1 rounded-full text-xs font-medium transition-colors"
            :class="
              formContexts.includes(ctx)
                ? 'bg-brand-100 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300'
                : 'bg-surface-2 text-slate-500 hover:text-slate-700 dark:bg-surface-2-dark dark:text-slate-400 dark:hover:text-slate-200'
            "
            @click="toggleContext(ctx)"
          >
            {{ t(`settings.filterCtx_${ctx}`) }}
          </button>
        </div>
      </div>

      <div>
        <label class="sb-label">
          {{ t('settings.filterAction') }}
        </label>
        <div class="flex gap-4">
          <label class="flex items-center gap-2 cursor-pointer">
            <input
              v-model="formAction"
              type="radio"
              value="warn"
              class="border-outline text-brand-600 focus:ring-brand-500 dark:border-outline-dark dark:bg-surface-2-dark"
            />
            <span class="text-sm text-slate-700 dark:text-slate-200">{{ t('settings.filterActionWarn') }}</span>
          </label>
          <label class="flex items-center gap-2 cursor-pointer">
            <input
              v-model="formAction"
              type="radio"
              value="hide"
              class="border-outline text-brand-600 focus:ring-brand-500 dark:border-outline-dark dark:bg-surface-2-dark"
            />
            <span class="text-sm text-slate-700 dark:text-slate-200">{{ t('settings.filterActionHide') }}</span>
          </label>
        </div>
      </div>

      <div class="flex gap-2">
        <button
          :disabled="formSaving || !formTitle.trim()"
          class="sb-btn sb-btn-primary"
          @click="saveFilter"
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

    <!-- Filter List -->
    <div v-else-if="filters.length === 0 && !showForm" class="sb-empty">
      <p>{{ t('settings.noFilters') }}</p>
    </div>

    <div v-else class="space-y-3">
      <div
        v-for="filter in filters"
        :key="filter.id"
        class="sb-card p-5"
      >
        <div class="flex items-start justify-between">
          <div>
            <h3 class="font-semibold text-slate-900 dark:text-slate-100">{{ filter.title }}</h3>
            <p class="text-sm text-slate-500 dark:text-slate-400 mt-1">
              {{ filter.keywords.map((k) => k.keyword).join(', ') }}
            </p>
            <div class="flex flex-wrap gap-1 mt-2">
              <span
                v-for="ctx in filter.context"
                :key="ctx"
                class="px-2 py-0.5 rounded-full text-xs font-medium bg-surface-2 text-slate-500 dark:bg-surface-2-dark dark:text-slate-400"
              >
                {{ t(`settings.filterCtx_${ctx}`) }}
              </span>
              <span
                class="px-2 py-0.5 rounded-full text-xs font-medium"
                :class="
                  filter.filter_action === 'hide'
                    ? 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-400'
                    : 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400'
                "
              >
                {{ t(`settings.filterAction${filter.filter_action === 'hide' ? 'Hide' : 'Warn'}`) }}
              </span>
            </div>
          </div>
          <div class="flex gap-1">
            <button
              class="p-2 rounded-lg text-slate-400 transition-colors hover:bg-surface-2 hover:text-slate-700 dark:hover:bg-surface-2-dark dark:hover:text-slate-200"
              @click="openEditForm(filter)"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
              </svg>
            </button>
            <button
              class="p-2 rounded-lg text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/40 dark:hover:text-red-400"
              @click="deleteFilter(filter.id)"
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
</template>
