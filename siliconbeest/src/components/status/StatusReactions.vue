<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import type { Status, EmojiReaction } from '@/types/mastodon'
import { useAuthStore } from '@/stores/auth'
import { getReactions, addReaction, removeReaction } from '@/api/mastodon/statuses'
import EmojiPicker from '../common/EmojiPicker.vue'

const props = defineProps<{
  status: Status
}>()

const emit = defineEmits<{
  updated: [status: Status]
}>()

const authStore = useAuthStore()
const reactions = ref<EmojiReaction[]>([])
const loading = ref(false)
const showPicker = ref(false)
const pickerRef = ref<HTMLElement | null>(null)
const pickerBtnRef = ref<HTMLElement | null>(null)
const pickerAbove = ref(true)

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
  if (!authStore.token || loading.value) return
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
  if (!authStore.token || loading.value) return
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

function togglePicker() {
  showPicker.value = !showPicker.value
  if (showPicker.value) {
    nextTick(() => {
      if (pickerBtnRef.value) {
        const rect = pickerBtnRef.value.getBoundingClientRect()
        // 피커 높이 약 300px. 위에 공간이 부족하면 아래로 표시
        pickerAbove.value = rect.top > 320
      }
    })
  }
}

// 피커 외부 클릭 시 닫기
function handleClickOutside(e: MouseEvent) {
  if (
    pickerRef.value && !pickerRef.value.contains(e.target as Node) &&
    pickerBtnRef.value && !pickerBtnRef.value.contains(e.target as Node)
  ) {
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
  <div v-if="hasReactions || authStore.isAuthenticated" class="flex flex-wrap items-center gap-1.5">
    <!-- 리액션 칩들 -->
    <TransitionGroup name="reaction">
      <button
        v-for="reaction in reactions"
        :key="reaction.name"
        @click="!isRemoteCustomEmoji(reaction) && toggleReaction(reaction)"
        :disabled="loading || !authStore.isAuthenticated || isRemoteCustomEmoji(reaction)"
        class="inline-flex select-none items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
        :class="[
          isRemoteCustomEmoji(reaction)
            ? 'cursor-not-allowed border-outline bg-surface-2/60 text-slate-400 opacity-70 dark:border-outline-dark dark:bg-surface-2-dark/60 dark:text-slate-500'
            : reaction.me
              ? 'border-brand-300 bg-brand-50 text-brand-700 hover:bg-brand-100 dark:border-brand-600 dark:bg-brand-950/40 dark:text-brand-300 dark:hover:bg-brand-900/50'
              : 'border-outline bg-surface-2/60 text-slate-600 hover:border-brand-200 hover:bg-surface-2 dark:border-outline-dark dark:bg-surface-2-dark/60 dark:text-slate-300 dark:hover:border-brand-800 dark:hover:bg-surface-2-dark',
          isRemoteCustomEmoji(reaction) ? '' : loading ? 'opacity-60 cursor-wait' : authStore.isAuthenticated ? 'cursor-pointer' : 'cursor-default',
        ]"
        :title="isRemoteCustomEmoji(reaction) ? `${reaction.name} (다른 서버의 이모지)` : reaction.name"
      >
        <!-- 커스텀 이모지 이미지 -->
        <img
          v-if="isCustomEmoji(reaction)"
          :src="reaction.url!"
          :alt="getShortcode(reaction.name)"
          class="h-5 w-5 object-contain"
          loading="lazy"
        />
        <!-- 유니코드 이모지 -->
        <span v-else class="text-base leading-none">{{ reaction.name }}</span>
        <!-- 카운트 -->
        <span class="tabular-nums">{{ reaction.count }}</span>
      </button>
    </TransitionGroup>

    <!-- + 버튼 (이모지 피커 열기) -->
    <div v-if="authStore.isAuthenticated" class="relative">
      <button
        ref="pickerBtnRef"
        @click.stop="togglePicker"
        :disabled="loading"
        class="inline-flex h-7 w-7 items-center justify-center rounded-full border border-dashed border-outline text-slate-400 transition-colors hover:border-brand-400 hover:bg-brand-50 hover:text-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:border-outline-dark dark:text-slate-500 dark:hover:border-brand-500 dark:hover:bg-brand-950/30 dark:hover:text-brand-400"
        :class="loading ? 'opacity-60 cursor-wait' : 'cursor-pointer'"
        title="리액션 추가"
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
        </svg>
      </button>

      <!-- 이모지 피커 팝오버 -->
      <div
        v-if="showPicker"
        ref="pickerRef"
        class="absolute left-0 z-50"
        :class="pickerAbove ? 'bottom-full mb-2' : 'top-full mt-2'"
      >
        <EmojiPicker @select="handleEmojiSelect" />
      </div>
    </div>
  </div>
</template>
