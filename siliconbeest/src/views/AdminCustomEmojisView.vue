<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { apiFetch, apiFetchFormData } from '@/api/client'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import AdminLayout from '@/components/layout/AdminLayout.vue'

interface CustomEmoji {
  id: string
  shortcode: string
  url: string
  static_url: string
  visible_in_picker: boolean
  category: string | null
  created_at: string
  updated_at: string
}

const { t } = useI18n()
const authStore = useAuthStore()

const loading = ref(false)
const error = ref<string | null>(null)
const emojis = ref<CustomEmoji[]>([])

// Upload form state
const showForm = ref(false)
const formShortcode = ref('')
const formCategory = ref('')
const formFile = ref<File | null>(null)
const formSaving = ref(false)

// Inline editing state
const editingId = ref<string | null>(null)
const editCategory = ref('')
const editSaving = ref(false)

// Collapsed categories
const collapsedCategories = ref<Set<string>>(new Set())

onMounted(() => {
  loadEmojis()
})

async function loadEmojis() {
  loading.value = true
  error.value = null
  try {
    const { data } = await apiFetch<CustomEmoji[]>('/v1/admin/custom_emojis', {
      token: authStore.token ?? undefined,
    })
    emojis.value = data
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

// Group emojis by category
const emojisByCategory = computed(() => {
  const map = new Map<string, CustomEmoji[]>()
  for (const emoji of emojis.value) {
    const cat = emoji.category || '기타'
    if (!map.has(cat)) map.set(cat, [])
    map.get(cat)!.push(emoji)
  }
  return map
})

const categoryNames = computed(() => [...emojisByCategory.value.keys()])

// Collect existing categories for autocomplete
const existingCategories = computed(() => {
  const cats = new Set<string>()
  for (const emoji of emojis.value) {
    if (emoji.category) cats.add(emoji.category)
  }
  return [...cats].sort()
})

function toggleCategory(cat: string) {
  if (collapsedCategories.value.has(cat)) {
    collapsedCategories.value.delete(cat)
  } else {
    collapsedCategories.value.add(cat)
  }
}

function openUploadForm() {
  formShortcode.value = ''
  formCategory.value = ''
  formFile.value = null
  showForm.value = true
}

function cancelForm() {
  showForm.value = false
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  formFile.value = input.files?.[0] ?? null
}

async function uploadEmoji() {
  if (!formShortcode.value.trim() || !formFile.value) return

  formSaving.value = true
  error.value = null

  try {
    const fd = new FormData()
    fd.append('shortcode', formShortcode.value.trim())
    fd.append('image', formFile.value)
    if (formCategory.value.trim()) {
      fd.append('category', formCategory.value.trim())
    }

    await apiFetchFormData('/v1/admin/custom_emojis', fd, {
      token: authStore.token ?? undefined,
    })

    showForm.value = false
    await loadEmojis()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    formSaving.value = false
  }
}

async function deleteEmoji(id: string) {
  if (!confirm(t('admin.deleteEmojiConfirm'))) return

  try {
    await apiFetch(`/v1/admin/custom_emojis/${id}`, {
      method: 'DELETE',
      token: authStore.token ?? undefined,
    })
    await loadEmojis()
  } catch (e) {
    error.value = (e as Error).message
  }
}

function startEditCategory(emoji: CustomEmoji) {
  editingId.value = emoji.id
  editCategory.value = emoji.category || ''
}

function cancelEditCategory() {
  editingId.value = null
  editCategory.value = ''
}

async function saveCategory(emoji: CustomEmoji) {
  editSaving.value = true
  error.value = null
  try {
    await apiFetch(`/v1/admin/custom_emojis/${emoji.id}`, {
      method: 'PATCH',
      token: authStore.token ?? undefined,
      body: JSON.stringify({
        category: editCategory.value.trim() || null,
      }),
    })
    editingId.value = null
    editCategory.value = ''
    await loadEmojis()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    editSaving.value = false
  }
}
</script>

<template>
  <AdminLayout>
  <div class="w-full max-w-5xl animate-fade-in">
    <div class="mb-6 flex items-center justify-between">
      <h1 class="sb-heading text-2xl text-slate-900 dark:text-white">{{ t('admin.customEmojis') }}</h1>
      <button
        v-if="!showForm"
        class="sb-btn sb-btn-primary"
        @click="openUploadForm"
      >
        {{ t('admin.addEmoji') }}
      </button>
    </div>

    <!-- Error -->
    <div v-if="error" class="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
      {{ error }}
    </div>

    <!-- Upload Form -->
    <div v-if="showForm" class="sb-card mb-6 space-y-4 p-6 animate-rise-in">
      <h3 class="sb-heading text-lg text-slate-900 dark:text-white">
        {{ t('admin.addEmoji') }}
      </h3>

      <div>
        <label class="sb-label">
          {{ t('admin.emojiShortcode') }}
        </label>
        <input
          v-model="formShortcode"
          type="text"
          placeholder="custom_emoji"
          class="sb-input"
        />
        <p class="mt-1.5 text-xs text-slate-500 dark:text-slate-400">{{ t('admin.emojiShortcodeHint') }}</p>
      </div>

      <div>
        <label class="sb-label">
          {{ t('admin.emojiImage') }}
        </label>
        <input
          type="file"
          accept="image/png,image/gif,image/webp"
          class="w-full text-sm text-slate-500 dark:text-slate-400
            file:mr-4 file:cursor-pointer file:rounded-full file:border-0
            file:bg-brand-50 file:px-4 file:py-2
            file:text-sm file:font-semibold file:text-brand-700
            file:transition-colors hover:file:bg-brand-100
            dark:file:bg-brand-950/50 dark:file:text-brand-300
            dark:hover:file:bg-brand-950/80"
          @change="onFileChange"
        />
      </div>

      <div>
        <label class="sb-label">
          {{ t('admin.emojiCategory') }}
        </label>
        <input
          v-model="formCategory"
          type="text"
          list="emoji-categories"
          :placeholder="t('admin.emojiCategoryPlaceholder')"
          class="sb-input"
        />
        <datalist id="emoji-categories">
          <option v-for="cat in existingCategories" :key="cat" :value="cat" />
        </datalist>
      </div>

      <div class="flex gap-2">
        <button
          :disabled="formSaving || !formShortcode.trim() || !formFile"
          class="sb-btn sb-btn-primary"
          @click="uploadEmoji"
        >
          {{ formSaving ? t('common.uploading') : t('common.upload') }}
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

    <div v-else-if="emojis.length === 0 && !showForm" class="sb-card">
      <div class="sb-empty">
        <p>{{ t('admin.noEmojis') }}</p>
      </div>
    </div>

    <!-- Grouped by category -->
    <div v-else class="space-y-4">
      <div
        v-for="catName in categoryNames"
        :key="catName"
        class="sb-card overflow-hidden"
      >
        <!-- Category header -->
        <button
          type="button"
          class="flex w-full items-center justify-between px-4 py-3 transition-colors hover:bg-surface-2/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400 dark:hover:bg-surface-2-dark/70"
          @click="toggleCategory(catName)"
        >
          <div class="flex items-center gap-2">
            <svg
              class="h-4 w-4 text-slate-400 transition-transform dark:text-slate-500"
              :class="{ '-rotate-90': collapsedCategories.has(catName) }"
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
            <span class="text-sm font-semibold text-slate-900 dark:text-white">{{ catName }}</span>
            <span class="sb-chip">{{ emojisByCategory.get(catName)?.length ?? 0 }}</span>
          </div>
        </button>

        <!-- Emoji list (collapsible) -->
        <div v-if="!collapsedCategories.has(catName)" class="border-t border-outline dark:border-outline-dark">
          <div class="divide-y divide-outline dark:divide-outline-dark">
            <div
              v-for="emoji in emojisByCategory.get(catName)"
              :key="emoji.id"
              class="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-surface-2/70 dark:hover:bg-surface-2-dark/70"
            >
              <img
                :src="emoji.url"
                :alt="emoji.shortcode"
                class="h-8 w-8 flex-shrink-0 rounded object-contain"
              />
              <div class="min-w-0 flex-1">
                <code class="text-sm text-slate-900 dark:text-white">:{{ emoji.shortcode }}:</code>
                <!-- Category inline edit -->
                <div v-if="editingId === emoji.id" class="mt-1 flex items-center gap-1">
                  <input
                    v-model="editCategory"
                    type="text"
                    list="emoji-categories-edit"
                    class="w-40 rounded-lg border border-outline bg-surface px-2 py-0.5 text-xs text-slate-900 transition placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-100 dark:placeholder:text-slate-500"
                    :placeholder="t('admin.emojiCategoryPlaceholder')"
                    @keyup.enter="saveCategory(emoji)"
                    @keyup.escape="cancelEditCategory"
                  />
                  <datalist id="emoji-categories-edit">
                    <option v-for="cat in existingCategories" :key="cat" :value="cat" />
                  </datalist>
                  <button
                    class="rounded-full p-1 text-emerald-600 transition-colors hover:bg-emerald-50 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
                    :disabled="editSaving"
                    @click="saveCategory(emoji)"
                  >
                    <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                  </button>
                  <button
                    class="rounded-full p-1 text-slate-400 transition-colors hover:bg-surface-2 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:hover:bg-surface-2-dark dark:hover:text-slate-300"
                    @click="cancelEditCategory"
                  >
                    <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                  </button>
                </div>
                <button v-else class="mt-0.5 block text-xs text-slate-400 transition-colors hover:text-brand-500 dark:text-slate-500 dark:hover:text-brand-400" @click="startEditCategory(emoji)">
                  {{ emoji.category || t('admin.emojiCategoryPlaceholder') }}
                </button>
              </div>
              <button
                class="flex-shrink-0 rounded-full p-2 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                :title="t('common.delete')"
                @click="deleteEmoji(emoji.id)"
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
  </div>
  </AdminLayout>
</template>
