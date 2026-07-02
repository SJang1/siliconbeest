<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useEmojis } from '@/composables/useEmojis'

const { t } = useI18n()
const {
  customEmojis,
  customEmojisByCategory,
  unicodeCategories,
  fetchCustomEmojis,
  searchEmojis,
  getUnicodeByCategory,
} = useEmojis()

const emit = defineEmits<{
  select: [value: string]
}>()

const searchQuery = ref('')
const activeTab = ref<string>('People')

onMounted(() => {
  fetchCustomEmojis()
})

// Build tab list: Custom categories first, then unicode categories
const tabs = computed(() => {
  const result: string[] = []
  if (customEmojis.value.length > 0) {
    for (const cat of customEmojisByCategory.value.keys()) {
      result.push(cat)
    }
  }
  result.push(...unicodeCategories.value)
  return result
})

// Set active tab to first available when tabs load
watch(tabs, (t) => {
  if (t.length > 0 && !t.includes(activeTab.value)) {
    activeTab.value = t[0]!
  }
}, { immediate: true })

const filteredResults = computed(() => {
  if (!searchQuery.value.trim()) return null
  return searchEmojis(searchQuery.value.trim())
})

const customCategoryNames = computed(() => [...customEmojisByCategory.value.keys()])

function selectCustomEmoji(shortcode: string) {
  emit('select', `:${shortcode}:`)
}

function selectUnicodeEmoji(emoji: string) {
  emit('select', emoji)
}

// Tab icon mapping
const tabIcons: Record<string, string> = {
  People: '\u{1F600}',
  Nature: '\u{1F43E}',
  Food: '\u{1F354}',
  Activities: '\u{26BD}',
  Travel: '\u{1F30D}',
  Symbols: '\u{2764}\u{FE0F}',
  Flags: '\u{1F3F3}\u{FE0F}',
}

function getTabIcon(tab: string): string {
  return tabIcons[tab] ?? '\u{2B50}'
}
</script>

<template>
  <div class="w-72 max-h-80 flex flex-col rounded-lg bg-white dark:bg-gray-800 shadow-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
    <!-- Search bar -->
    <div class="p-2 border-b border-gray-200 dark:border-gray-700">
      <input
        v-model="searchQuery"
        type="text"
        :placeholder="t('compose.search_emoji')"
        class="w-full px-2.5 py-1.5 text-sm rounded-md bg-gray-100 dark:bg-gray-700 border-0 focus:outline-none focus:ring-2 focus:ring-indigo-500 placeholder-gray-400 dark:placeholder-gray-500"
      />
    </div>

    <!-- Search results -->
    <div v-if="filteredResults" class="flex-1 overflow-y-auto p-2 min-h-0">
      <!-- Custom emoji results -->
      <div v-if="filteredResults.custom.length > 0" class="mb-2">
        <div class="text-xs font-semibold text-gray-400 dark:text-gray-500 px-1 mb-1">Custom</div>
        <div class="grid grid-cols-8 gap-0.5">
          <button
            v-for="emoji in filteredResults.custom"
            :key="emoji.shortcode"
            type="button"
            @click="selectCustomEmoji(emoji.shortcode)"
            class="w-8 h-8 flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            :title="`:${emoji.shortcode}:`"
          >
            <img :src="emoji.static_url" :alt="emoji.shortcode" class="w-6 h-6 object-contain" loading="lazy" />
          </button>
        </div>
      </div>

      <!-- Unicode emoji results -->
      <div v-if="filteredResults.unicode.length > 0">
        <div class="text-xs font-semibold text-gray-400 dark:text-gray-500 px-1 mb-1">Emoji</div>
        <div class="grid grid-cols-8 gap-0.5">
          <button
            v-for="emoji in filteredResults.unicode"
            :key="emoji.name"
            type="button"
            @click="selectUnicodeEmoji(emoji.emoji)"
            class="w-8 h-8 flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-xl leading-none"
            :title="emoji.name"
          >
            {{ emoji.emoji }}
          </button>
        </div>
      </div>

      <!-- No results -->
      <div
        v-if="filteredResults.custom.length === 0 && filteredResults.unicode.length === 0"
        class="text-sm text-gray-400 dark:text-gray-500 text-center py-6"
      >
        {{ t('compose.no_custom_emoji') }}
      </div>
    </div>

    <!-- Tabbed browsing (when not searching) -->
    <template v-else>
      <!-- Category tabs -->
      <div class="flex items-center gap-0.5 px-1.5 py-1 border-b border-gray-200 dark:border-gray-700 overflow-x-auto scrollbar-none">
        <button
          v-for="tab in tabs"
          :key="tab"
          type="button"
          @click="activeTab = tab"
          class="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded text-sm transition-colors"
          :class="activeTab === tab
            ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400'
            : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400'"
          :title="tab"
        >
          <!-- Custom category: show first emoji image -->
          <template v-if="customCategoryNames.includes(tab)">
            <img
              v-if="customEmojisByCategory.get(tab)?.[0]"
              :src="customEmojisByCategory.get(tab)![0]!.static_url"
              class="w-5 h-5 object-contain"
              :alt="tab"
            />
            <span v-else class="text-xs">*</span>
          </template>
          <!-- Unicode category icon -->
          <template v-else>
            {{ getTabIcon(tab) }}
          </template>
        </button>
      </div>

      <!-- Emoji grid for active tab -->
      <div class="flex-1 overflow-y-auto p-2 min-h-0" style="max-height: 220px;">
        <!-- Custom emoji tab -->
        <template v-if="customCategoryNames.includes(activeTab)">
          <div class="grid grid-cols-8 gap-0.5">
            <button
              v-for="emoji in customEmojisByCategory.get(activeTab)"
              :key="emoji.shortcode"
              type="button"
              @click="selectCustomEmoji(emoji.shortcode)"
              class="w-8 h-8 flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              :title="`:${emoji.shortcode}:`"
            >
              <img :src="emoji.static_url" :alt="emoji.shortcode" class="w-6 h-6 object-contain" loading="lazy" />
            </button>
          </div>
          <div v-if="!customEmojisByCategory.get(activeTab)?.length" class="text-sm text-gray-400 dark:text-gray-500 text-center py-6">
            {{ t('compose.no_custom_emoji') }}
          </div>
        </template>

        <!-- Unicode emoji tab -->
        <template v-else>
          <div class="grid grid-cols-8 gap-0.5">
            <button
              v-for="emoji in getUnicodeByCategory(activeTab)"
              :key="emoji.name"
              type="button"
              @click="selectUnicodeEmoji(emoji.emoji)"
              class="w-8 h-8 flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-xl leading-none"
              :title="emoji.name"
            >
              {{ emoji.emoji }}
            </button>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>
