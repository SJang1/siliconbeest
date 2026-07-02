<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { apiFetchFormData } from '@/api/client'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()
const authStore = useAuthStore()

const loading = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)
const success = ref(false)

const displayName = ref('')
const note = ref('')
const locked = ref(false)
const bot = ref(false)
const discoverable = ref(false)
const avatarFile = ref<File | null>(null)
const headerFile = ref<File | null>(null)
const avatarPreview = ref('')
const headerPreview = ref('')
const fields = ref<{ name: string; value: string }[]>([])

onMounted(() => {
  if (authStore.currentUser) {
    displayName.value = authStore.currentUser.display_name
    note.value = authStore.currentUser.source?.note ?? ''
    locked.value = authStore.currentUser.locked
    bot.value = authStore.currentUser.bot
    discoverable.value = authStore.currentUser.discoverable ?? false
    avatarPreview.value = authStore.currentUser.avatar
    headerPreview.value = authStore.currentUser.header
    fields.value = (authStore.currentUser.source?.fields ?? authStore.currentUser.fields ?? [])
      .filter((f) => f.name.trim() || f.value.trim())
      .map((f) => ({ name: f.name, value: f.value }))
  }
})

function onAvatarChange(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) {
    avatarFile.value = file
    avatarPreview.value = URL.createObjectURL(file)
  }
}

function onHeaderChange(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) {
    headerFile.value = file
    headerPreview.value = URL.createObjectURL(file)
  }
}

function addField() {
  fields.value.push({ name: '', value: '' })
}

function removeField(index: number) {
  fields.value.splice(index, 1)
}

async function saveProfile() {
  saving.value = true
  error.value = null
  success.value = false

  try {
    const formData = new FormData()
    formData.append('display_name', displayName.value)
    formData.append('note', note.value)
    formData.append('locked', String(locked.value))
    formData.append('bot', String(bot.value))
    formData.append('discoverable', String(discoverable.value))

    if (avatarFile.value) {
      formData.append('avatar', avatarFile.value)
    }
    if (headerFile.value) {
      formData.append('header', headerFile.value)
    }

    const populatedFields = fields.value.filter((field) => field.name.trim() || field.value.trim())
    if (populatedFields.length === 0) {
      formData.append('fields_attributes', '[]')
    }

    populatedFields.forEach((field, i) => {
      formData.append(`fields_attributes[${i}][name]`, field.name)
      formData.append(`fields_attributes[${i}][value]`, field.value)
    })

    await apiFetchFormData('/v1/accounts/update_credentials', formData, {
      token: authStore.token ?? undefined,
      method: 'PATCH',
    })

    await authStore.fetchCurrentUser()
    success.value = true
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="w-full">
    <h2 class="sb-heading text-xl mb-6">{{ t('settings.profile') }}</h2>

    <LoadingSpinner v-if="loading" />

    <form v-else class="space-y-6" @submit.prevent="saveProfile">
      <!-- Identity images -->
      <div class="sb-card p-6 space-y-6">
        <!-- Avatar -->
        <div>
          <label class="sb-label">
            {{ t('settings.avatar') }}
          </label>
          <div class="flex items-center gap-4">
            <span v-if="avatarPreview" class="sb-avatar-ring inline-flex shrink-0">
              <img
                :src="avatarPreview"
                :alt="t('settings.avatar')"
                class="w-20 h-20 rounded-full object-cover ring-2 ring-surface dark:ring-surface-dark"
              />
            </span>
            <div
              v-else
              class="w-20 h-20 rounded-full bg-surface-2 dark:bg-surface-2-dark flex items-center justify-center shrink-0"
            >
              <svg class="w-8 h-8 text-slate-400 dark:text-slate-500" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 12c2.7 0 5-2.3 5-5s-2.3-5-5-5-5 2.3-5 5 2.3 5 5 5zm0 2c-3.3 0-10 1.7-10 5v3h20v-3c0-3.3-6.7-5-10-5z"/>
              </svg>
            </div>
            <input
              type="file"
              accept="image/*"
              class="text-sm text-slate-500 dark:text-slate-400 file:mr-3 file:rounded-full file:border-0 file:px-4 file:py-1.5 file:text-sm file:font-semibold file:bg-brand-50 file:text-brand-700 hover:file:bg-brand-100 dark:file:bg-brand-950/60 dark:file:text-brand-300 dark:hover:file:bg-brand-900/60 file:transition-colors"
              @change="onAvatarChange"
            />
          </div>
        </div>

        <hr class="sb-divider" />

        <!-- Header -->
        <div>
          <label class="sb-label">
            {{ t('settings.header') }}
          </label>
          <div class="space-y-3">
            <div
              v-if="headerPreview"
              class="w-full h-32 rounded-xl overflow-hidden border border-outline dark:border-outline-dark shadow-soft"
            >
              <img :src="headerPreview" :alt="t('settings.header')" class="w-full h-full object-cover" />
            </div>
            <div
              v-else
              class="w-full h-32 rounded-xl bg-surface-2 dark:bg-surface-2-dark flex items-center justify-center"
            >
              <span class="text-sm text-slate-400 dark:text-slate-500">{{ t('settings.noHeader') }}</span>
            </div>
            <input
              type="file"
              accept="image/*"
              class="text-sm text-slate-500 dark:text-slate-400 file:mr-3 file:rounded-full file:border-0 file:px-4 file:py-1.5 file:text-sm file:font-semibold file:bg-brand-50 file:text-brand-700 hover:file:bg-brand-100 dark:file:bg-brand-950/60 dark:file:text-brand-300 dark:hover:file:bg-brand-900/60 file:transition-colors"
              @change="onHeaderChange"
            />
          </div>
        </div>
      </div>

      <!-- About you -->
      <div class="sb-card p-6 space-y-4">
        <!-- Display Name -->
        <div>
          <label class="sb-label">
            {{ t('settings.displayName') }}
          </label>
          <input
            v-model="displayName"
            type="text"
            class="sb-input"
          />
        </div>

        <!-- Bio -->
        <div>
          <label class="sb-label">
            {{ t('settings.bio') }}
          </label>
          <textarea
            v-model="note"
            rows="4"
            class="sb-input resize-none"
          />
        </div>
      </div>

      <!-- Privacy toggles -->
      <div class="sb-card p-6 space-y-1">
        <label class="flex items-center justify-between gap-4 cursor-pointer rounded-xl px-2 py-2.5 transition-colors hover:bg-surface-2 dark:hover:bg-surface-2-dark">
          <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('settings.lockAccount') }}</span>
          <span class="relative inline-flex shrink-0">
            <input
              v-model="locked"
              type="checkbox"
              class="peer sr-only"
            />
            <span class="h-6 w-11 rounded-full bg-slate-300 transition-colors peer-checked:bg-linear-to-r peer-checked:from-brand-600 peer-checked:to-violet-600 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-400 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-white dark:bg-slate-600 dark:peer-focus-visible:ring-offset-surface-dark"></span>
            <span class="pointer-events-none absolute left-1 top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5"></span>
          </span>
        </label>

        <label class="flex items-center justify-between gap-4 cursor-pointer rounded-xl px-2 py-2.5 transition-colors hover:bg-surface-2 dark:hover:bg-surface-2-dark">
          <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('settings.botAccount') }}</span>
          <span class="relative inline-flex shrink-0">
            <input
              v-model="bot"
              type="checkbox"
              class="peer sr-only"
            />
            <span class="h-6 w-11 rounded-full bg-slate-300 transition-colors peer-checked:bg-linear-to-r peer-checked:from-brand-600 peer-checked:to-violet-600 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-400 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-white dark:bg-slate-600 dark:peer-focus-visible:ring-offset-surface-dark"></span>
            <span class="pointer-events-none absolute left-1 top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5"></span>
          </span>
        </label>

        <label class="flex items-center justify-between gap-4 cursor-pointer rounded-xl px-2 py-2.5 transition-colors hover:bg-surface-2 dark:hover:bg-surface-2-dark">
          <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('settings.discoverable') }}</span>
          <span class="relative inline-flex shrink-0">
            <input
              v-model="discoverable"
              type="checkbox"
              class="peer sr-only"
            />
            <span class="h-6 w-11 rounded-full bg-slate-300 transition-colors peer-checked:bg-linear-to-r peer-checked:from-brand-600 peer-checked:to-violet-600 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-400 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-white dark:bg-slate-600 dark:peer-focus-visible:ring-offset-surface-dark"></span>
            <span class="pointer-events-none absolute left-1 top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5"></span>
          </span>
        </label>
      </div>

      <!-- Profile Fields -->
      <div class="sb-card p-6">
        <div class="flex items-center justify-between mb-3">
          <label class="sb-label mb-0">
            {{ t('settings.profileFields') }}
          </label>
          <button
            type="button"
            class="text-sm font-semibold text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300 transition-colors"
            @click="addField"
          >
            {{ t('settings.addField') }}
          </button>
        </div>
        <div v-for="(field, index) in fields" :key="index" class="flex gap-2 mb-2">
          <input
            v-model="field.name"
            type="text"
            :placeholder="t('settings.fieldName')"
            class="sb-input flex-1"
          />
          <input
            v-model="field.value"
            type="text"
            :placeholder="t('settings.fieldValue')"
            class="sb-input flex-1"
          />
          <button
            type="button"
            class="sb-btn sb-btn-ghost !px-2 text-red-500 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950/40 dark:hover:!text-red-300"
            @click="removeField(index)"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- Error / Success -->
      <div v-if="error" class="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-sm">
        {{ error }}
      </div>
      <div v-if="success" class="p-3 rounded-xl bg-green-50 dark:bg-green-950/40 text-green-600 dark:text-green-400 text-sm">
        {{ t('settings.saved') }}
      </div>

      <!-- Save Button -->
      <button
        type="submit"
        :disabled="saving"
        class="sb-btn sb-btn-primary w-full"
      >
        {{ saving ? t('common.loading') : t('common.save') }}
      </button>
    </form>
  </div>
</template>
