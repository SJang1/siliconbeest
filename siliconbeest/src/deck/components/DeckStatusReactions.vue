<script setup lang="ts">
// Deck-only reactions row. Logic mirrored from
// src/components/status/StatusReactions.vue (Aurora) — keep behavior in
// sync. Differences: no standalone ＋ button (the picker opens from the
// star chooser in DeckStatusActions via the exposed openPicker()), and an
// `overlay` emit so the card can raise its z-index while the picker is
// open (each deck card is its own stacking context).
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Status, EmojiReaction } from '@/types/mastodon'
import { useAuthStore } from '@/stores/auth'
import { getReactions, addReaction, removeReaction } from '@/api/mastodon/statuses'
import EmojiPicker from '@/components/common/EmojiPicker.vue'

const { t } = useI18n()

const props = defineProps<{
  status: Status
}>()

const emit = defineEmits<{
  updated: [status: Status]
  overlay: [open: boolean]
}>()

const authStore = useAuthStore()
const reactions = ref<EmojiReaction[]>([])
const loading = ref(false)
const showPicker = ref(false)
const containerRef = ref<HTMLElement | null>(null)
const pickerRef = ref<HTMLElement | null>(null)
const pickerAbove = ref(true)

const hasReactions = computed(() => reactions.value.length > 0)

watch(showPicker, (open) => emit('overlay', open))

async function fetchReactions() {
  try {
    const { data } = await getReactions(props.status.id, authStore.token ?? undefined)
    reactions.value = data
  } catch {
    // Non-critical, ignore
  }
}

onMounted(() => {
  fetchReactions()
})

watch(() => props.status.id, () => {
  fetchReactions()
})

async function toggleReaction(reaction: EmojiReaction) {
  if (!authStore.token || loading.value) return
  loading.value = true

  try {
    if (reaction.me) {
      const { data } = await removeReaction(props.status.id, reaction.name, authStore.token)
      emit('updated', data)
    } else {
      const { data } = await addReaction(props.status.id, reaction.name, authStore.token)
      emit('updated', data)
    }
    await fetchReactions()
  } catch {
    // Ignore
  } finally {
    loading.value = false
  }
}

async function handleEmojiSelect(emoji: string) {
  showPicker.value = false
  if (!authStore.token || loading.value) return
  loading.value = true

  // Custom emojis arrive as :shortcode:, unicode emojis as-is — pass through
  try {
    const { data } = await addReaction(props.status.id, emoji, authStore.token)
    emit('updated', data)
    await fetchReactions()
  } catch {
    // Ignore
  } finally {
    loading.value = false
  }
}

/** Opened from the star chooser in DeckStatusActions. */
function openPicker() {
  showPicker.value = true
  nextTick(() => {
    if (containerRef.value) {
      const rect = containerRef.value.getBoundingClientRect()
      // Picker is ~300px tall; drop below when there is no room above
      pickerAbove.value = rect.top > 320
    }
  })
}

defineExpose({ openPicker })

function handleClickOutside(e: MouseEvent) {
  if (pickerRef.value && !pickerRef.value.contains(e.target as Node)) {
    showPicker.value = false
  }
}

watch(showPicker, (val) => {
  if (val) {
    setTimeout(() => {
      document.addEventListener('click', handleClickOutside)
    }, 0)
  } else {
    document.removeEventListener('click', handleClickOutside)
  }
})

function isCustomEmoji(reaction: EmojiReaction): boolean {
  return reaction.name.startsWith(':') && reaction.name.endsWith(':') && !!reaction.url
}

// Remote custom emojis don't exist locally, so they can't be added here
function isRemoteCustomEmoji(reaction: EmojiReaction): boolean {
  if (!isCustomEmoji(reaction)) return false
  return !!reaction.url && reaction.url.includes('/proxy?url=')
}

function getShortcode(name: string): string {
  return name.replace(/^:|:$/g, '')
}
</script>

<template>
  <div v-if="hasReactions || showPicker" ref="containerRef" class="relative flex flex-wrap items-center gap-1.5">
    <TransitionGroup name="reaction">
      <button
        v-for="reaction in reactions"
        :key="reaction.name"
        type="button"
        class="inline-flex select-none items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[14px] transition-all duration-200"
        :style="{
          border: '1px solid ' + (reaction.me ? 'var(--dk-acc)' : 'var(--dk-border)'),
          background: reaction.me ? 'color-mix(in oklab, var(--dk-acc) 24%, transparent)' : 'var(--dk-surface2)',
          color: reaction.me ? 'var(--dk-text)' : 'var(--dk-dim)',
          opacity: isRemoteCustomEmoji(reaction) ? 0.7 : 1,
          cursor: isRemoteCustomEmoji(reaction) || !authStore.isAuthenticated ? 'default' : loading ? 'wait' : 'pointer',
        }"
        :disabled="loading || !authStore.isAuthenticated || isRemoteCustomEmoji(reaction)"
        :aria-pressed="!!reaction.me"
        :title="isRemoteCustomEmoji(reaction) ? `${reaction.name} (${t('deck.remote_reaction_hint')})` : reaction.name"
        @click="!isRemoteCustomEmoji(reaction) && toggleReaction(reaction)"
      >
        <img
          v-if="isCustomEmoji(reaction)"
          :src="reaction.url!"
          :alt="getShortcode(reaction.name)"
          class="h-5 w-5 object-contain"
          loading="lazy"
        />
        <span v-else class="text-base leading-none">{{ reaction.name }}</span>
        <span class="dk-mono text-[11.5px] tabular-nums">{{ reaction.count }}</span>
      </button>
    </TransitionGroup>

    <!-- Emoji picker popover (opened from the star chooser) -->
    <div
      v-if="showPicker"
      ref="pickerRef"
      class="absolute left-0 z-50"
      :class="pickerAbove ? 'bottom-full mb-2' : 'top-full mt-2'"
    >
      <EmojiPicker @select="handleEmojiSelect" />
    </div>
  </div>
</template>
