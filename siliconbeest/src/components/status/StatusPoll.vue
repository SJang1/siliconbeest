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
      <div v-if="showResults" class="relative overflow-hidden rounded-xl bg-surface-2/60 dark:bg-surface-2-dark/60">
        <div
          class="absolute inset-y-0 left-0 rounded-xl transition-all duration-500"
          :class="poll.own_votes?.includes(idx)
            ? 'bg-linear-to-r from-brand-500/30 via-violet-500/30 to-fuchsia-500/30 dark:from-brand-400/35 dark:via-violet-400/35 dark:to-fuchsia-400/35'
            : 'bg-linear-to-r from-slate-400/25 to-slate-400/10 dark:from-slate-500/30 dark:to-slate-500/15'"
          :style="{ width: `${percentage(option.votes_count)}%` }"
        />
        <div class="relative flex items-center justify-between px-3.5 py-2 text-sm">
          <span :class="poll.own_votes?.includes(idx) ? 'font-semibold text-brand-700 dark:text-brand-300' : 'font-medium text-slate-700 dark:text-slate-200'">
            {{ option.title }}
            <span v-if="poll.own_votes?.includes(idx)" class="text-xs ml-1">✓</span>
          </span>
          <span class="ml-2 text-xs tabular-nums text-slate-500 dark:text-slate-400">{{ percentage(option.votes_count) }}%</span>
        </div>
      </div>

      <!-- Voting view -->
      <button
        v-else
        type="button"
        @click="toggleChoice(idx)"
        class="w-full flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
        :class="selectedChoices.includes(idx)
          ? 'border-brand-400 bg-brand-50 text-brand-700 shadow-soft dark:border-brand-500 dark:bg-brand-950/40 dark:text-brand-300'
          : 'border-outline text-slate-700 hover:border-brand-300 hover:bg-surface-2/60 dark:border-outline-dark dark:text-slate-300 dark:hover:border-brand-700 dark:hover:bg-surface-2-dark/60'"
      >
        <span
          class="flex-shrink-0 w-4 h-4 border-2 flex items-center justify-center transition-colors"
          :class="[
            poll.multiple ? 'rounded' : 'rounded-full',
            selectedChoices.includes(idx) ? 'border-brand-500 dark:border-brand-400' : 'border-slate-300 dark:border-slate-600',
          ]"
        >
          <span v-if="selectedChoices.includes(idx)" class="w-2 h-2 bg-linear-to-br from-brand-500 to-violet-500" :class="poll.multiple ? 'rounded-sm' : 'rounded-full'" />
        </span>
        <span>{{ option.title }}</span>
      </button>
    </div>

    <!-- Vote button -->
    <button
      v-if="!showResults && auth.isAuthenticated"
      :disabled="selectedChoices.length === 0 || voting"
      @click="vote"
      class="sb-btn sb-btn-primary sb-btn-sm"
    >
      <svg v-if="voting" class="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
      {{ t('poll.vote') }}
    </button>

    <!-- Meta info -->
    <div class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
      <span>{{ t('poll.total_votes', { n: totalVotes }) }}</span>
      <span v-if="timeRemaining">&middot;</span>
      <span v-if="timeRemaining">{{ timeRemaining }}</span>
    </div>

    <div v-if="error" class="text-xs font-medium text-red-500">{{ error }}</div>
  </div>
</template>
