<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { apiFetch } from '@/api/client'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import AdminLayout from '@/components/layout/AdminLayout.vue'

interface Rule {
  id: string
  text: string
  priority?: number
}

const { t } = useI18n()
const auth = useAuthStore()

const rules = ref<Rule[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

const showForm = ref(false)
const editingId = ref<string | null>(null)
const formText = ref('')
const formPriority = ref(0)
const formSaving = ref(false)

onMounted(loadRules)

async function loadRules() {
  loading.value = true
  error.value = null
  try {
    const { data } = await apiFetch<Rule[]>('/v1/admin/rules', {
      token: auth.token ?? undefined,
    })
    rules.value = data
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

function openCreate() {
  editingId.value = null
  formText.value = ''
  formPriority.value = rules.value.length
  showForm.value = true
}

function openEdit(rule: Rule) {
  editingId.value = rule.id
  formText.value = rule.text
  formPriority.value = rule.priority ?? 0
  showForm.value = true
}

function cancelForm() {
  showForm.value = false
  editingId.value = null
}

async function saveRule() {
  if (!formText.value.trim()) return
  formSaving.value = true
  error.value = null
  try {
    const body = { text: formText.value, priority: formPriority.value }
    if (editingId.value) {
      await apiFetch(`/v1/admin/rules/${editingId.value}`, {
        method: 'PUT',
        token: auth.token ?? undefined,
        body: JSON.stringify(body),
      })
    } else {
      await apiFetch('/v1/admin/rules', {
        method: 'POST',
        token: auth.token ?? undefined,
        body: JSON.stringify(body),
      })
    }
    showForm.value = false
    editingId.value = null
    await loadRules()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    formSaving.value = false
  }
}

async function deleteRule(id: string) {
  if (!confirm(t('admin.deleteRuleConfirm'))) return
  try {
    await apiFetch(`/v1/admin/rules/${id}`, {
      method: 'DELETE',
      token: auth.token ?? undefined,
    })
    await loadRules()
  } catch (e) {
    error.value = (e as Error).message
  }
}
</script>

<template>
  <AdminLayout>
  <div class="w-full max-w-5xl animate-fade-in">
    <div class="mb-6 flex items-center justify-between">
      <h1 class="sb-heading text-2xl text-slate-900 dark:text-white">{{ t('admin.rules') }}</h1>
      <button
        v-if="!showForm"
        class="sb-btn sb-btn-primary"
        @click="openCreate"
      >
        {{ t('admin.addRule') }}
      </button>
    </div>

    <div v-if="error" class="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
      {{ error }}
    </div>

    <!-- Form -->
    <div v-if="showForm" class="sb-card mb-6 space-y-4 p-6 animate-rise-in">
      <h3 class="sb-heading text-lg text-slate-900 dark:text-white">
        {{ editingId ? t('admin.editRule') : t('admin.addRule') }}
      </h3>
      <div>
        <label class="sb-label">{{ t('admin.ruleText') }}</label>
        <textarea
          v-model="formText"
          rows="3"
          class="sb-input resize-none"
          :placeholder="t('admin.ruleTextPlaceholder')"
        />
      </div>
      <div class="flex gap-2">
        <button
          :disabled="formSaving || !formText.trim()"
          class="sb-btn sb-btn-primary"
          @click="saveRule"
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

    <div v-else-if="rules.length === 0 && !showForm" class="sb-card">
      <div class="sb-empty">
        {{ t('admin.noRules') }}
      </div>
    </div>

    <div v-else class="sb-card divide-y divide-outline overflow-hidden dark:divide-outline-dark">
      <div
        v-for="(rule, index) in rules"
        :key="rule.id"
        class="flex items-center gap-4 p-4 transition-colors hover:bg-surface-2/70 dark:hover:bg-surface-2-dark/70"
      >
        <span class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand-50 text-sm font-bold text-brand-600 dark:bg-brand-950/60 dark:text-brand-400">
          {{ index + 1 }}
        </span>
        <p class="flex-1 whitespace-pre-line text-sm text-slate-900 dark:text-white">{{ rule.text }}</p>
        <div class="flex gap-1">
          <button
            class="rounded-full p-2 text-slate-400 transition-colors hover:bg-surface-2 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:hover:bg-surface-2-dark dark:hover:text-slate-200"
            @click="openEdit(rule)"
          >
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
            </svg>
          </button>
          <button
            class="rounded-full p-2 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:hover:bg-red-950/40 dark:hover:text-red-400"
            @click="deleteRule(rule.id)"
          >
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  </div>
  </AdminLayout>
</template>
