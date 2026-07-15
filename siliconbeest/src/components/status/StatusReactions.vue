<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import type { Status, EmojiReaction } from '@/types/mastodon'
import { useAuthStore } from '@/stores/auth'
import { getReactions, addReaction, removeReaction } from '@/api/mastodon/statuses'
import EmojiPicker from '../common/EmojiPicker.vue'
import { canUseAuthenticatedActions } from '@/utils/permissions'

const props = defineProps<{
  status: Status
}>()

const emit = defineEmits<{
  updated: [status: Status]
}>()

const authStore = useAuthStore()
const accountCanAct = computed(() => canUseAuthenticatedActions({
  authenticated: authStore.isAuthenticated,
  accountLoaded: authStore.currentUser !== null,
  accountSuspended: authStore.currentUser?.suspended,
  accountMemorial: authStore.currentUser?.memorial,
}))
const reactions = ref<EmojiReaction[]>([])
const loading = ref(false)
const showPicker = ref(false)
const pickerRef = ref<HTMLElement | null>(null)
const rootRef = ref<HTMLElement | null>(null)

// 리액션이 있는지 확인
const hasReactions = computed(() => reactions.value.length > 0)

// 리액션 목록 가져오기
async function fetchReactions() {
  try {
    const { data } = await getReactions(props.status.id, authStore.token ?? undefined)
    reactions.value = data
  } catch {
    // 에러 무시
  }
}

onMounted(() => {
  fetchReactions()
})

// status가 변경되면 리액션 다시 가져오기
watch(() => props.status.id, () => {
  fetchReactions()
})

// 리액션 토글 (추가/제거)
async function toggleReaction(reaction: EmojiReaction) {
  if (!accountCanAct.value || !authStore.token || loading.value) return
  loading.value = true

  try {
    if (reaction.me) {
      // 리액션 제거
      const { data } = await removeReaction(props.status.id, reaction.name, authStore.token)
      emit('updated', data)
    } else {
      // 리액션 추가
      const { data } = await addReaction(props.status.id, reaction.name, authStore.token)
      emit('updated', data)
    }
    // 리액션 목록 새로고침
    await fetchReactions()
  } catch {
    // 에러 무시
  } finally {
    loading.value = false
  }
}

// 이모지 피커에서 선택
async function handleEmojiSelect(emoji: string) {
  showPicker.value = false
  if (!accountCanAct.value || !authStore.token || loading.value) return
  loading.value = true

  // 커스텀 이모지는 :shortcode: 형식으로 전달됨 → 백엔드에도 그대로 전달
  // 유니코드 이모지는 그대로 전달
  try {
    const { data } = await addReaction(props.status.id, emoji, authStore.token)
    emit('updated', data)
    await fetchReactions()
  } catch {
    // 에러 무시
  } finally {
    loading.value = false
  }
}

// ---------------------------------------------------------------------------
// 이모지 피커 — body로 Teleport + fixed 좌표라 overflow-hidden/스크롤 컨테이너에
// 가려지지 않음. 앵커(좋아요 버튼 또는 리액션 칩 행) 기준으로 위/아래 배치를
// 결정하고 뷰포트 안으로 클램프한다.
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

// 외부(액션 메뉴의 "이모지로 반응")에서 피커 열기
async function openPicker(anchor?: HTMLElement) {
  if (!accountCanAct.value || loading.value) return
  anchorEl = anchor ?? rootRef.value
  showPicker.value = true
  await nextTick()
  computePickerPosition()
}

defineExpose({ openPicker })

// 피커 외부 클릭 시 닫기
function handleClickOutside(e: MouseEvent) {
  const target = e.target as Node
  if (pickerRef.value && !pickerRef.value.contains(target)) {
    showPicker.value = false
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') showPicker.value = false
}

// 스크롤/리사이즈 시 앵커를 따라 재배치
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

// 커스텀 이모지인지 확인
function isCustomEmoji(reaction: EmojiReaction): boolean {
  return reaction.name.startsWith(':') && reaction.name.endsWith(':') && !!reaction.url
}

// 리모트 서버의 커스텀 이모지인지 확인 (로컬에 없으므로 반응 추가 불가)
function isRemoteCustomEmoji(reaction: EmojiReaction): boolean {
  if (!isCustomEmoji(reaction)) return false
  // 리모트 이모지는 /proxy?url= 경로로 제공됨, 로컬은 /media/ 경로
  return !!reaction.url && reaction.url.includes('/proxy?url=')
}

// 커스텀 이모지 shortcode 추출
function getShortcode(name: string): string {
  return name.replace(/^:|:$/g, '')
}
</script>

<template>
  <div v-if="hasReactions || showPicker" ref="rootRef" class="flex flex-wrap items-center gap-1.5">
    <!-- 리액션 칩들 (추가는 액션 줄의 좋아요 메뉴 → "이모지로 반응"으로 통합) -->
    <TransitionGroup name="reaction">
      <button
        v-for="reaction in reactions"
        :key="reaction.name"
        @click="!isRemoteCustomEmoji(reaction) && toggleReaction(reaction)"
        :disabled="loading || !accountCanAct || isRemoteCustomEmoji(reaction)"
        class="inline-flex min-h-9 touch-manipulation select-none items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
        :class="[
          isRemoteCustomEmoji(reaction)
            ? 'cursor-not-allowed border-outline bg-surface-2/60 text-slate-400 opacity-70 dark:border-outline-dark dark:bg-surface-2-dark/60 dark:text-slate-500'
            : reaction.me
              ? 'border-brand-300 bg-brand-50 text-brand-700 hover:bg-brand-100 dark:border-brand-600 dark:bg-brand-950/40 dark:text-brand-300 dark:hover:bg-brand-900/50'
              : 'border-outline bg-surface-2/60 text-slate-600 hover:border-brand-200 hover:bg-surface-2 dark:border-outline-dark dark:bg-surface-2-dark/60 dark:text-slate-300 dark:hover:border-brand-800 dark:hover:bg-surface-2-dark',
          isRemoteCustomEmoji(reaction) ? '' : loading ? 'opacity-60 cursor-wait' : accountCanAct ? 'cursor-pointer' : 'cursor-default',
        ]"
        :title="isRemoteCustomEmoji(reaction) ? `${reaction.name} (다른 서버의 이모지)` : reaction.name"
      >
        <!-- 커스텀 이모지 이미지 -->
        <img
          v-if="isCustomEmoji(reaction)"
          :src="reaction.url!"
          :alt="getShortcode(reaction.name)"
          class="h-6 w-6 object-contain"
          loading="lazy"
        />
        <!-- 유니코드 이모지 -->
        <span v-else class="text-lg leading-none">{{ reaction.name }}</span>
        <!-- 카운트 -->
        <span class="tabular-nums">{{ reaction.count }}</span>
      </button>
    </TransitionGroup>

    <!-- 이모지 피커 — body에 고정 배치되어 어떤 컨테이너에도 잘리지 않음 -->
    <Teleport to="body">
      <div
        v-if="showPicker"
        ref="pickerRef"
        class="fixed z-[80] shadow-lift"
        :style="pickerStyle"
        @click.stop
      >
        <EmojiPicker @select="handleEmojiSelect" />
      </div>
    </Teleport>
  </div>
</template>
