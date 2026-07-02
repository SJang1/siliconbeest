<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { createReport } from '@/api/mastodon/reports'
import { apiFetch } from '@/api/client'
import Modal from './Modal.vue'

const { t } = useI18n()
const authStore = useAuthStore()

const props = defineProps<{
  open: boolean
  accountId: string
  accountAcct: string
  statusId?: string
}>()

const emit = defineEmits<{
  close: []
}>()

const category = ref<'spam' | 'violation' | 'legal' | 'other'>('other')
const comment = ref('')
const forward = ref(false)
const selectedRules = ref<number[]>([])
const rules = ref<Array<{ id: number; text: string }>>([])
const loading = ref(false)
const error = ref('')

const isRemote = () => props.accountAcct.includes('@')

watch(() => props.open, async (opened) => {
  if (opened) {
    // Reset form
    category.value = 'other'
    comment.value = ''
    forward.value = false
    selectedRules.value = []
    error.value = ''
    // Fetch rules
    try {
      const { data } = await apiFetch<Array<{ id: number; text: string }>>('/api/v1/instance/rules')
      rules.value = data
    } catch {
      rules.value = []
    }
  }
})

function toggleRule(id: number) {
  const idx = selectedRules.value.indexOf(id)
  if (idx === -1) {
    selectedRules.value.push(id)
  } else {
    selectedRules.value.splice(idx, 1)
  }
}

async function submit() {
  if (loading.value) return
  loading.value = true
  error.value = ''

  try {
    await createReport({
      account_id: props.accountId,
      status_ids: props.statusId ? [props.statusId] : undefined,
      comment: comment.value || undefined,
      category: category.value,
      forward: isRemote() ? forward.value : undefined,
      rule_ids: category.value === 'violation' && selectedRules.value.length > 0
        ? selectedRules.value
        : undefined,
    }, authStore.token!)

    alert(t('report.success'))
    emit('close')
  } catch {
    error.value = t('report.error')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <Modal :open="open" :title="t('report.title')" @close="emit('close')">
    <form @submit.prevent="submit" class="space-y-4">
      <!-- Category -->
      <fieldset>
        <legend class="sb-label">
          {{ t('report.category') }}
        </legend>
        <div class="space-y-2">
          <label
            v-for="cat in (['spam', 'violation', 'legal', 'other'] as const)"
            :key="cat"
            class="flex cursor-pointer items-center gap-2.5 rounded-xl px-2 py-1.5 transition-colors hover:bg-surface-2 dark:hover:bg-surface-2-dark"
          >
            <input
              type="radio"
              :value="cat"
              v-model="category"
              class="h-4 w-4 accent-brand-600 dark:accent-brand-400"
            />
            <span class="text-sm text-slate-700 dark:text-slate-200">{{ t(`report.${cat}`) }}</span>
          </label>
        </div>
      </fieldset>

      <!-- Rules (when category is violation) -->
      <fieldset v-if="category === 'violation' && rules.length > 0">
        <legend class="sb-label">
          {{ t('report.select_rules') }}
        </legend>
        <div class="max-h-40 space-y-2 overflow-y-auto rounded-xl border border-outline bg-surface-2/50 p-3 dark:border-outline-dark dark:bg-surface-2-dark/50">
          <label
            v-for="rule in rules"
            :key="rule.id"
            class="flex cursor-pointer items-start gap-2.5"
          >
            <input
              type="checkbox"
              :checked="selectedRules.includes(rule.id)"
              @change="toggleRule(rule.id)"
              class="mt-0.5 h-4 w-4 rounded accent-brand-600 dark:accent-brand-400"
            />
            <span class="text-sm whitespace-pre-line text-slate-700 dark:text-slate-200">{{ rule.text }}</span>
          </label>
        </div>
      </fieldset>

      <!-- Comment -->
      <div>
        <label class="sb-label">
          {{ t('report.comment') }}
        </label>
        <textarea
          v-model="comment"
          :placeholder="t('report.comment_placeholder')"
          rows="3"
          class="sb-input resize-none"
        />
      </div>

      <!-- Forward checkbox (remote users only) -->
      <label v-if="isRemote()" class="flex cursor-pointer items-start gap-2.5 rounded-xl px-2 py-1.5 transition-colors hover:bg-surface-2 dark:hover:bg-surface-2-dark">
        <input
          type="checkbox"
          v-model="forward"
          class="mt-0.5 h-4 w-4 rounded accent-brand-600 dark:accent-brand-400"
        />
        <div>
          <span class="text-sm text-slate-700 dark:text-slate-200">{{ t('report.forward') }}</span>
          <p class="text-xs text-slate-500 dark:text-slate-400">{{ t('report.forward_hint') }}</p>
        </div>
      </label>

      <!-- Error -->
      <p v-if="error" class="text-sm text-red-600 dark:text-red-400">{{ error }}</p>

      <!-- Buttons -->
      <div class="flex justify-end gap-2 pt-2">
        <button
          type="button"
          @click="emit('close')"
          class="sb-btn sb-btn-secondary"
        >
          {{ t('report.cancel') }}
        </button>
        <button
          type="submit"
          :disabled="loading"
          class="sb-btn sb-btn-danger"
        >
          {{ t('report.submit') }}
        </button>
      </div>
    </form>
  </Modal>
</template>
