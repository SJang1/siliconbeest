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
    fields.value = (authStore.currentUser.source?.fields ?? authStore.currentUser.fields ?? []).map(
      (f) => ({ name: f.name, value: f.value })
    )
    if (fields.value.length === 0) {
      fields.value.push({ name: '', value: '' })
    }
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

    fields.value.forEach((field, i) => {
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
    <h2 class="text-xl font-bold mb-6 text-gray-900 dark:text-white">{{ t('settings.profile') }}</h2>

    <LoadingSpinner v-if="loading" />

    <form v-else class="space-y-6" @submit.prevent="saveProfile">
      <!-- Avatar -->
      <div>
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          {{ t('settings.avatar') }}
        </label>
        <div class="flex items-center gap-4">
          <img
            v-if="avatarPreview"
            :src="avatarPreview"
            :alt="t('settings.avatar')"
            class="w-20 h-20 rounded-full object-cover border-2 border-gray-200 dark:border-gray-700"
          />
          <div
            v-else
            class="w-20 h-20 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center"
          >
            <svg class="w-8 h-8 text-gray-400" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 12c2.7 0 5-2.3 5-5s-2.3-5-5-5-5 2.3-5 5 2.3 5 5 5zm0 2c-3.3 0-10 1.7-10 5v3h20v-3c0-3.3-6.7-5-10-5z"/>
            </svg>
          </div>
          <input
            type="file"
            accept="image/*"
            class="text-sm text-gray-600 dark:text-gray-400 file:mr-2 file:py-1 file:px-3 file:rounded-lg file:border-0 file:text-sm file:bg-indigo-50 file:text-indigo-700 dark:file:bg-indigo-900/30 dark:file:text-indigo-400 hover:file:bg-indigo-100"
            @change="onAvatarChange"
          />
        </div>
      </div>

      <!-- Header -->
      <div>
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          {{ t('settings.header') }}
        </label>
        <div class="space-y-2">
          <div
            v-if="headerPreview"
            class="w-full h-32 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700"
          >
            <img :src="headerPreview" :alt="t('settings.header')" class="w-full h-full object-cover" />
          </div>
          <div
            v-else
            class="w-full h-32 rounded-lg bg-gray-200 dark:bg-gray-700 flex items-center justify-center"
          >
            <span class="text-sm text-gray-400">{{ t('settings.noHeader') }}</span>
          </div>
          <input
            type="file"
            accept="image/*"
            class="text-sm text-gray-600 dark:text-gray-400 file:mr-2 file:py-1 file:px-3 file:rounded-lg file:border-0 file:text-sm file:bg-indigo-50 file:text-indigo-700 dark:file:bg-indigo-900/30 dark:file:text-indigo-400 hover:file:bg-indigo-100"
            @change="onHeaderChange"
          />
        </div>
      </div>

      <!-- Display Name -->
      <div>
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {{ t('settings.displayName') }}
        </label>
        <input
          v-model="displayName"
          type="text"
          class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>

      <!-- Bio -->
      <div>
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {{ t('settings.bio') }}
        </label>
        <textarea
          v-model="note"
          rows="4"
          class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
        />
      </div>

      <!-- Checkboxes -->
      <div class="space-y-3">
        <label class="flex items-center gap-3 cursor-pointer">
          <input
            v-model="locked"
            type="checkbox"
            class="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
          />
          <span class="text-sm text-gray-700 dark:text-gray-300">{{ t('settings.lockAccount') }}</span>
        </label>

        <label class="flex items-center gap-3 cursor-pointer">
          <input
            v-model="bot"
            type="checkbox"
            class="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
          />
          <span class="text-sm text-gray-700 dark:text-gray-300">{{ t('settings.botAccount') }}</span>
        </label>

        <label class="flex items-center gap-3 cursor-pointer">
          <input
            v-model="discoverable"
            type="checkbox"
            class="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
          />
          <span class="text-sm text-gray-700 dark:text-gray-300">{{ t('settings.discoverable') }}</span>
        </label>
      </div>

      <!-- Profile Fields -->
      <div>
        <div class="flex items-center justify-between mb-2">
          <label class="text-sm font-medium text-gray-700 dark:text-gray-300">
            {{ t('settings.profileFields') }}
          </label>
          <button
            type="button"
            class="text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
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
            class="flex-1 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <input
            v-model="field.value"
            type="text"
            :placeholder="t('settings.fieldValue')"
            class="flex-1 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button
            type="button"
            class="p-2 text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
            @click="removeField(index)"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- Error / Success -->
      <div v-if="error" class="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
        {{ error }}
      </div>
      <div v-if="success" class="p-3 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 text-sm">
        {{ t('settings.saved') }}
      </div>

      <!-- Save Button -->
      <button
        type="submit"
        :disabled="saving"
        class="w-full px-4 py-2 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {{ saving ? t('common.loading') : t('common.save') }}
      </button>
    </form>
  </div>
</template>
