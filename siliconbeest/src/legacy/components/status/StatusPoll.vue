<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Poll } from '@/types/mastodon'
import { apiFetch } from '@/api/client'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()
const auth = useAuthStore()

const props = defineProps<{
  poll: Poll
}>()

const emit = defineEmits<{
  updated: [poll: Poll]
}>()

const selectedChoices = ref<number[]>([])
const voting = ref(false)
const error = ref<string | null>(null)

const hasVoted = computed(() => props.poll.voted ?? false)
const isExpired = computed(() => props.poll.expired)
const showResults = computed(() => hasVoted.value || isExpired.value)
const totalVotes = computed(() => props.poll.votes_count || 0)

const timeRemaining = computed(() => {
  if (!props.poll.expires_at) return null
  const end = new Date(props.poll.expires_at).getTime()
  const now = Date.now()
  if (end <= now) return t('poll.closed')
  const diffMs = end - now
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 60) return t('poll.minutes_left', { n: diffMins })
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return t('poll.hours_left', { n: diffHours })
  const diffDays = Math.floor(diffHours / 24)
  return t('poll.days_left', { n: diffDays })
})

function toggleChoice(idx: number) {
  if (showResults.value) return
  if (props.poll.multiple) {
    const i = selectedChoices.value.indexOf(idx)
    if (i >= 0) selectedChoices.value.splice(i, 1)
    else selectedChoices.value.push(idx)
  } else {
    selectedChoices.value = [idx]
  }
}

async function vote() {
  if (!auth.token || selectedChoices.value.length === 0 || voting.value) return
  voting.value = true
  error.value = null
  try {
    const { data } = await apiFetch<Poll>(`/v1/polls/${props.poll.id}/votes`, {
      method: 'POST',
      token: auth.token,
      body: { choices: selectedChoices.value },
    })
    emit('updated', data)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    voting.value = false
  }
}

function percentage(count: number | null): number {
  if (!count || !totalVotes.value) return 0
  return Math.round((count / totalVotes.value) * 100)
}
</script>

<template>
  <div class="mt-3 space-y-2">
    <div v-for="(option, idx) in poll.options" :key="idx">
      <!-- Results view -->
      <div v-if="showResults" class="relative">
        <div
          class="absolute inset-0 rounded-md transition-all"
          :class="poll.own_votes?.includes(idx) ? 'bg-indigo-100 dark:bg-indigo-900/30' : 'bg-gray-100 dark:bg-gray-800'"
          :style="{ width: `${percentage(option.votes_count)}%` }"
        />
        <div class="relative flex items-center justify-between px-3 py-2 text-sm">
          <span class="font-medium" :class="poll.own_votes?.includes(idx) ? 'text-indigo-700 dark:text-indigo-300' : ''">
            {{ option.title }}
            <span v-if="poll.own_votes?.includes(idx)" class="text-xs ml-1">✓</span>
          </span>
          <span class="text-gray-500 dark:text-gray-400 text-xs ml-2">{{ percentage(option.votes_count) }}%</span>
        </div>
      </div>

      <!-- Voting view -->
      <button
        v-else
        type="button"
        @click="toggleChoice(idx)"
        class="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md border transition-colors"
        :class="selectedChoices.includes(idx)
          ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300'
          : 'border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500'"
      >
        <span
          class="flex-shrink-0 w-4 h-4 border-2 flex items-center justify-center"
          :class="poll.multiple ? 'rounded' : 'rounded-full'"
        >
          <span v-if="selectedChoices.includes(idx)" class="w-2 h-2 bg-indigo-600 dark:bg-indigo-400" :class="poll.multiple ? 'rounded-sm' : 'rounded-full'" />
        </span>
        <span>{{ option.title }}</span>
      </button>
    </div>

    <!-- Vote button -->
    <button
      v-if="!showResults && auth.isAuthenticated"
      :disabled="selectedChoices.length === 0 || voting"
      @click="vote"
      class="px-4 py-1.5 text-sm font-medium rounded-md border border-indigo-500 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      <svg v-if="voting" class="w-4 h-4 animate-spin inline mr-1" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
      {{ t('poll.vote') }}
    </button>

    <!-- Meta info -->
    <div class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
      <span>{{ t('poll.total_votes', { n: totalVotes }) }}</span>
      <span v-if="timeRemaining">&middot;</span>
      <span v-if="timeRemaining">{{ timeRemaining }}</span>
    </div>

    <div v-if="error" class="text-xs text-red-500">{{ error }}</div>
  </div>
</template>
