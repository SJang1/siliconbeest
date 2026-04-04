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
  <div class="w-full">
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white">{{ t('admin.rules') }}</h1>
      <button
        v-if="!showForm"
        class="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
        @click="openCreate"
      >
        {{ t('admin.addRule') }}
      </button>
    </div>

    <div v-if="error" class="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
      {{ error }}
    </div>

    <!-- Form -->
    <div v-if="showForm" class="mb-6 p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 space-y-4">
      <h3 class="text-lg font-medium text-gray-900 dark:text-white">
        {{ editingId ? t('admin.editRule') : t('admin.addRule') }}
      </h3>
      <div>
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ t('admin.ruleText') }}</label>
        <textarea
          v-model="formText"
          rows="3"
          class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
          :placeholder="t('admin.ruleTextPlaceholder')"
        />
      </div>
      <div class="flex gap-2">
        <button
          :disabled="formSaving || !formText.trim()"
          class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          @click="saveRule"
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

    <div v-else-if="rules.length === 0 && !showForm" class="text-center py-12 text-gray-500 dark:text-gray-400">
      {{ t('admin.noRules') }}
    </div>

    <div v-else class="space-y-3">
      <div
        v-for="(rule, index) in rules"
        :key="rule.id"
        class="flex items-center gap-4 p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
      >
        <span class="flex-shrink-0 w-8 h-8 rounded-full bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center text-sm font-bold">
          {{ index + 1 }}
        </span>
        <p class="flex-1 text-sm text-gray-900 dark:text-white whitespace-pre-line">{{ rule.text }}</p>
        <div class="flex gap-1">
          <button class="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" @click="openEdit(rule)">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
            </svg>
          </button>
          <button class="p-1.5 text-gray-400 hover:text-red-500 dark:hover:text-red-400" @click="deleteRule(rule.id)">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  </div>
  </AdminLayout>
</template>
