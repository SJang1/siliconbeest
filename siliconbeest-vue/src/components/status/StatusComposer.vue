<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Listbox, ListboxButton, ListboxOptions, ListboxOption } from '@headlessui/vue'

const { t } = useI18n()

const props = defineProps<{
  replyTo?: { id: string; account: { acct: string } }
  maxChars?: number
}>()

const emit = defineEmits<{
  submit: [payload: {
    content: string
    spoiler_text: string
    visibility: string
    in_reply_to_id?: string
  }]
}>()

const content = ref('')
const spoilerText = ref('')
const showCw = ref(false)
const charLimit = computed(() => props.maxChars ?? 500)
const charsRemaining = computed(() => charLimit.value - content.value.length)

const visibilityOptions = [
  { value: 'public', label: 'compose.visibility.public', icon: '🌐' },
  { value: 'unlisted', label: 'compose.visibility.unlisted', icon: '🔓' },
  { value: 'private', label: 'compose.visibility.private', icon: '🔒' },
  { value: 'direct', label: 'compose.visibility.direct', icon: '✉️' },
]
const selectedVisibility = ref(visibilityOptions[0])

function submit() {
  if (!content.value.trim() || charsRemaining.value < 0) return
  emit('submit', {
    content: content.value,
    spoiler_text: showCw.value ? spoilerText.value : '',
    visibility: selectedVisibility.value.value,
    in_reply_to_id: props.replyTo?.id,
  })
  content.value = ''
  spoilerText.value = ''
  showCw.value = false
}
</script>

<template>
  <form @submit.prevent="submit" class="p-4 border-b border-gray-200 dark:border-gray-700">
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

    <!-- Toolbar -->
    <div class="flex items-center justify-between mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
      <div class="flex items-center gap-2">
        <!-- Media upload -->
        <button
          type="button"
          class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400"
          :aria-label="t('compose.add_media')"
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
              class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400"
              :aria-label="t('compose.visibility.label')"
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
          :disabled="!content.trim() || charsRemaining < 0"
          class="px-4 py-1.5 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {{ t('compose.submit') }}
        </button>
      </div>
    </div>
  </form>
</template>
