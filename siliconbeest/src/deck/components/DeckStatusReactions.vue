<script setup lang="ts">
// Deck-only reactions row. Logic mirrored from
// src/components/status/StatusReactions.vue (Aurora) — keep behavior in
// sync. Differences: no standalone ＋ button (the picker opens from the
// star chooser in DeckStatusActions via the exposed openPicker()), and an
// `overlay` emit so the card can raise its z-index while the picker is
// open (each deck card is its own stacking context).
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Status, EmojiReaction } from '@/types/mastodon'
import { useAuthStore } from '@/stores/auth'
import { useStatusesStore } from '@/stores/statuses'
import { getReactions, addReaction, removeReaction } from '@/api/mastodon/statuses'
import EmojiPicker from '@/components/common/EmojiPicker.vue'
import { canUseAuthenticatedActions } from '@/utils/permissions'

const { t } = useI18n()

const props = defineProps<{
  status: Status
}>()

const emit = defineEmits<{
  updated: [status: Status]
  overlay: [open: boolean]
}>()

const authStore = useAuthStore()
const accountCanAct = computed(() => canUseAuthenticatedActions({
  authenticated: authStore.isAuthenticated,
  accountLoaded: authStore.currentUser !== null,
  accountSuspended: authStore.currentUser?.suspended,
  accountMemorial: authStore.currentUser?.memorial,
}))
const statusesStore = useStatusesStore()
const reactions = ref<EmojiReaction[]>([])
const loading = ref(false)
const showPicker = ref(false)
const containerRef = ref<HTMLElement | null>(null)
const pickerRef = ref<HTMLElement | null>(null)

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

// Live updates: the `reaction` websocket event pings the statuses store
watch(
  () => statusesStore.reactionPings.get(props.status.id),
  () => {
    void fetchReactions()
  },
)

async function toggleReaction(reaction: EmojiReaction) {
  if (!accountCanAct.value || !authStore.token || loading.value) return
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
  if (!accountCanAct.value || !authStore.token || loading.value) return
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

// ---------------------------------------------------------------------------
// Emoji picker — teleported to <body> with fixed, viewport-clamped
// coordinates so the columns' overflow scroll containers can't clip it.
// Anchored to the star chooser button (passed by DeckStatusCard), falling
// back to the reactions row.
// ---------------------------------------------------------------------------
const PICKER_WIDTH = 288 // w-72
const PICKER_HEIGHT = 320 // max-h-80
const PICKER_MARGIN = 8

const pickerStyle = ref<Record<string, string>>({})
let anchorEl: HTMLElement | null = null

function computePickerPosition() {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const rect = anchorEl?.isConnected ? anchorEl.getBoundingClientRect() : null

  let top: number
  let left: number
  if (rect) {
    const spaceBelow = vh - rect.bottom - PICKER_MARGIN
    const spaceAbove = rect.top - PICKER_MARGIN
    if (spaceBelow >= PICKER_HEIGHT) {
      top = rect.bottom + PICKER_MARGIN
    } else if (spaceAbove >= PICKER_HEIGHT) {
      top = rect.top - PICKER_MARGIN - PICKER_HEIGHT
    } else {
      top = (vh - PICKER_HEIGHT) / 2
    }
    left = rect.left
  } else {
    top = (vh - PICKER_HEIGHT) / 2
    left = (vw - PICKER_WIDTH) / 2
  }

  left = Math.max(PICKER_MARGIN, Math.min(left, vw - PICKER_WIDTH - PICKER_MARGIN))
  top = Math.max(PICKER_MARGIN, Math.min(top, vh - PICKER_HEIGHT - PICKER_MARGIN))
  pickerStyle.value = { top: `${top}px`, left: `${left}px` }
}

/** Opened from the star chooser in DeckStatusActions. */
async function openPicker(anchor?: HTMLElement) {
  if (!accountCanAct.value || loading.value) return
  anchorEl = anchor ?? containerRef.value
  showPicker.value = true
  await nextTick()
  computePickerPosition()
}

defineExpose({ openPicker })

function handleClickOutside(e: MouseEvent) {
  if (pickerRef.value && !pickerRef.value.contains(e.target as Node)) {
    showPicker.value = false
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') showPicker.value = false
}

// Follow the anchor while the column scrolls or the window resizes
function handleWindowChange() {
  computePickerPosition()
}

function removePickerListeners() {
  document.removeEventListener('click', handleClickOutside)
  document.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('scroll', handleWindowChange, true)
  window.removeEventListener('resize', handleWindowChange)
}

watch(showPicker, (val) => {
  if (val) {
    setTimeout(() => {
      document.addEventListener('click', handleClickOutside)
    }, 0)
    document.addEventListener('keydown', handleKeydown)
    window.addEventListener('scroll', handleWindowChange, true)
    window.addEventListener('resize', handleWindowChange)
  } else {
    removePickerListeners()
    anchorEl = null
  }
})

onUnmounted(removePickerListeners)

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
        class="inline-flex min-h-9 select-none items-center gap-1.5 rounded-full px-3 py-1.5 text-[15px] transition-all duration-200"
        :style="{
          border: '1px solid ' + (reaction.me ? 'var(--dk-acc)' : 'var(--dk-border)'),
          background: reaction.me ? 'color-mix(in oklab, var(--dk-acc) 24%, transparent)' : 'var(--dk-surface2)',
          color: reaction.me ? 'var(--dk-text)' : 'var(--dk-dim)',
          opacity: isRemoteCustomEmoji(reaction) ? 0.7 : 1,
          cursor: isRemoteCustomEmoji(reaction) || !accountCanAct ? 'default' : loading ? 'wait' : 'pointer',
        }"
        :disabled="loading || !accountCanAct || isRemoteCustomEmoji(reaction)"
        :aria-pressed="!!reaction.me"
        :title="isRemoteCustomEmoji(reaction) ? `${reaction.name} (${t('deck.remote_reaction_hint')})` : reaction.name"
        @click="!isRemoteCustomEmoji(reaction) && toggleReaction(reaction)"
      >
        <img
          v-if="isCustomEmoji(reaction)"
          :src="reaction.url!"
          :alt="getShortcode(reaction.name)"
          class="h-6 w-6 object-contain"
          loading="lazy"
        />
        <span v-else class="text-lg leading-none">{{ reaction.name }}</span>
        <span class="dk-mono text-xs tabular-nums">{{ reaction.count }}</span>
      </button>
    </TransitionGroup>

    <!-- Emoji picker popover (opened from the star chooser) — teleported to
         <body> and fixed so the column's overflow scroll can't clip it -->
    <Teleport to="body">
      <div
        v-if="showPicker"
        ref="pickerRef"
        class="fixed z-[80]"
        :style="pickerStyle"
        @click.stop
      >
        <EmojiPicker @select="handleEmojiSelect" />
      </div>
    </Teleport>
  </div>
</template>
