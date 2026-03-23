<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Listbox, ListboxButton, ListboxOptions, ListboxOption } from '@headlessui/vue'
import { useComposeStore } from '@/stores/compose'

const { t } = useI18n()
const compose = useComposeStore()

const props = defineProps<{
  replyTo?: { id: string; account: { acct: string } }
  maxChars?: number
}>()

const emit = defineEmits<{
  submit: [payload: {
    content: string
    spoiler_text: string
    visibility: string
    language: string
    in_reply_to_id?: string
    media_ids?: string[]
  }]
}>()

const content = ref('')
const spoilerText = ref('')
const showCw = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const charLimit = computed(() => props.maxChars ?? 500)
const charsRemaining = computed(() => charLimit.value - content.value.length)

const languageOptions = [
  { code: 'ko', label: '한국어' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'zh', label: '中文' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'pt', label: 'Português' },
  { code: 'ru', label: 'Русский' },
  { code: 'ar', label: 'العربية' },
]
const selectedLanguage = ref(
  languageOptions.find(l => l.code === (navigator.language?.split('-')[0] || 'en')) || languageOptions[1]!
)

const visibilityOptions = [
  { value: 'public', label: 'compose.visibility.public', icon: '🌐' },
  { value: 'unlisted', label: 'compose.visibility.unlisted', icon: '🔓' },
  { value: 'private', label: 'compose.visibility.private', icon: '🔒' },
  { value: 'direct', label: 'compose.visibility.direct', icon: '✉️' },
]
const selectedVisibility = ref(visibilityOptions[0]!)

const canSubmit = computed(() => {
  const hasContent = content.value.trim().length > 0 || compose.mediaAttachments.length > 0
  return hasContent && charsRemaining.value >= 0 && !compose.uploading
})

function triggerFileInput() {
  fileInput.value?.click()
}

async function onFileSelect(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files) return

  for (const file of Array.from(input.files)) {
    if (compose.mediaAttachments.length >= 4) break
    await compose.addMedia(file)
  }

  // Reset input so the same file can be re-selected
  input.value = ''
}

function submit() {
  if (!canSubmit.value) return
  emit('submit', {
    content: content.value,
    spoiler_text: showCw.value ? spoilerText.value : '',
    visibility: selectedVisibility.value.value,
    language: selectedLanguage.value.code,
    in_reply_to_id: props.replyTo?.id,
    media_ids: compose.mediaAttachments.map(m => m.id),
  })
  content.value = ''
  spoilerText.value = ''
  showCw.value = false
  compose.mediaAttachments.splice(0)
}
</script>

<template>
  <form @submit.prevent="submit" class="p-4 border-b border-gray-200 dark:border-gray-700">
    <!-- Hidden file input -->
    <input
      ref="fileInput"
      type="file"
      accept="image/*,video/*,audio/*,.webp,.gif"
      multiple
      class="hidden"
      @change="onFileSelect"
    />

    <!-- Reply indicator -->
    <div v-if="replyTo" class="text-sm text-gray-500 dark:text-gray-400 mb-2">
      {{ t('compose.replying_to', { name: `@${replyTo.account.acct}` }) }}
    </div>

    <!-- CW input -->
    <input
      v-if="showCw"
      v-model="spoilerText"
      type="text"
      :placeholder="t('compose.cw_placeholder')"
      class="w-full mb-2 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500"
    />

    <!-- Main textarea -->
    <textarea
      v-model="content"
      :placeholder="t('compose.placeholder')"
      rows="4"
      class="w-full px-3 py-2 text-base bg-transparent border-0 resize-none focus:outline-none placeholder-gray-400 dark:placeholder-gray-500"
      :aria-label="t('compose.placeholder')"
    />

    <!-- Media previews -->
    <div v-if="compose.mediaAttachments.length > 0" class="flex gap-2 mt-2 flex-wrap">
      <div
        v-for="media in compose.mediaAttachments"
        :key="media.id"
        class="relative group w-24 h-24 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700"
      >
        <img
          v-if="media.type === 'image' || media.type === 'gifv'"
          :src="media.preview_url ?? media.url"
          :alt="media.description ?? ''"
          class="w-full h-full object-cover"
        />
        <div v-else class="w-full h-full flex items-center justify-center bg-gray-100 dark:bg-gray-800 text-2xl">
          {{ media.type === 'video' ? '🎬' : '🎵' }}
        </div>
        <button
          type="button"
          @click="compose.removeMedia(media.id)"
          class="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/60 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
          aria-label="Remove"
        >
          ✕
        </button>
      </div>
    </div>

    <!-- Upload progress -->
    <div v-if="compose.uploading" class="flex items-center gap-2 mt-2 text-sm text-gray-500 dark:text-gray-400">
      <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
      {{ t('compose.uploading') }}
    </div>

    <!-- Toolbar -->
    <div class="flex items-center justify-between mt-3 pt-3 border-t border-gray-300 dark:border-gray-600">
      <div class="flex items-center gap-1.5 flex-wrap">
        <!-- Media upload -->
        <button
          type="button"
          @click="triggerFileInput"
          :disabled="compose.mediaAttachments.length >= 4 || compose.uploading"
          class="p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-lg"
          :aria-label="t('compose.add_media')"
          :title="t('compose.add_media')"
        >
          📎
        </button>

        <!-- CW toggle -->
        <button
          type="button"
          @click="showCw = !showCw"
          class="px-2 py-1 rounded text-xs font-semibold border transition-colors"
          :class="showCw
            ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
            : 'border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400'"
          :aria-label="t('compose.toggle_cw')"
        >
          CW
        </button>

        <!-- Visibility selector -->
        <Listbox v-model="selectedVisibility">
          <div class="relative">
            <ListboxButton
              class="p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 text-lg"
              :aria-label="t('compose.visibility.label')"
              :title="t('compose.visibility.label')"
            >
              {{ selectedVisibility.icon }}
            </ListboxButton>
            <ListboxOptions
              class="absolute bottom-full mb-1 w-48 rounded-lg bg-white dark:bg-gray-800 shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-10"
            >
              <ListboxOption
                v-for="option in visibilityOptions"
                :key="option.value"
                :value="option"
                class="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 text-sm"
              >
                <span>{{ option.icon }}</span>
                <span>{{ t(option.label) }}</span>
              </ListboxOption>
            </ListboxOptions>
          </div>
        </Listbox>

        <!-- Language selector -->
        <Listbox v-model="selectedLanguage">
          <div class="relative">
            <ListboxButton
              class="px-2 py-1 rounded text-xs font-semibold border border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 uppercase"
              :aria-label="t('compose.language')"
            >
              {{ selectedLanguage.code }}
            </ListboxButton>
            <ListboxOptions
              class="absolute bottom-full mb-1 w-36 max-h-48 overflow-auto rounded-lg bg-white dark:bg-gray-800 shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-10"
            >
              <ListboxOption
                v-for="lang in languageOptions"
                :key="lang.code"
                :value="lang"
                class="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 text-sm"
              >
                <span class="uppercase font-mono text-xs text-gray-400 w-5">{{ lang.code }}</span>
                <span>{{ lang.label }}</span>
              </ListboxOption>
            </ListboxOptions>
          </div>
        </Listbox>

        <!-- Media count -->
        <span v-if="compose.mediaAttachments.length > 0" class="text-xs text-gray-400 dark:text-gray-500">
          {{ compose.mediaAttachments.length }}/4
        </span>
      </div>

      <div class="flex items-center gap-3">
        <!-- Char counter -->
        <span
          class="text-sm"
          :class="charsRemaining < 0 ? 'text-red-500' : 'text-gray-400 dark:text-gray-500'"
        >
          {{ charsRemaining }}
        </span>

        <!-- Submit -->
        <button
          type="submit"
          :disabled="!canSubmit"
          class="px-4 py-1.5 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {{ t('compose.submit') }}
        </button>
      </div>
    </div>
  </form>
</template>
