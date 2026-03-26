<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
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
        class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border transition-all duration-200 select-none"
        :class="[
          isRemoteCustomEmoji(reaction)
            ? 'bg-gray-50 dark:bg-gray-700/50 border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 cursor-not-allowed opacity-70'
            : reaction.me
              ? 'bg-indigo-50 dark:bg-indigo-900/30 border-indigo-300 dark:border-indigo-600 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/50'
              : 'bg-gray-50 dark:bg-gray-700/50 border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600/50',
          isRemoteCustomEmoji(reaction) ? '' : loading ? 'opacity-60 cursor-wait' : authStore.isAuthenticated ? 'cursor-pointer' : 'cursor-default',
        ]"
        :title="isRemoteCustomEmoji(reaction) ? `${reaction.name} (다른 서버의 이모지)` : reaction.name"
      >
        <!-- 커스텀 이모지 이미지 -->
        <img
          v-if="isCustomEmoji(reaction)"
          :src="reaction.url!"
          :alt="getShortcode(reaction.name)"
          class="h-4 w-4 object-contain"
          loading="lazy"
        />
        <!-- 유니코드 이모지 -->
        <span v-else class="text-sm leading-none">{{ reaction.name }}</span>
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
        class="inline-flex items-center justify-center w-7 h-7 rounded-full border border-dashed border-gray-300 dark:border-gray-600 text-gray-400 dark:text-gray-500 hover:border-indigo-400 dark:hover:border-indigo-500 hover:text-indigo-500 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors"
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
        class="absolute bottom-full mb-2 left-0 z-50"
      >
        <EmojiPicker @select="handleEmojiSelect" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 리액션 추가/제거 애니메이션 */
.reaction-enter-active {
  transition: all 0.2s ease-out;
}
.reaction-leave-active {
  transition: all 0.15s ease-in;
}
.reaction-enter-from {
  opacity: 0;
  transform: scale(0.8);
}
.reaction-leave-to {
  opacity: 0;
  transform: scale(0.8);
}
.reaction-move {
  transition: transform 0.2s ease;
}
</style>
