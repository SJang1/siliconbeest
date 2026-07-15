<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import {
  createInvitation,
  getInvitationCredits,
  listInvitations,
  revokeInvitation,
} from '@/api/mastodon/invitations'
import { getApiErrorMessage } from '@/utils/apiError'
import type {
  InvitationCredits,
  InvitationSummary,
} from '@/types/registration'

withDefaults(defineProps<{ legacy?: boolean }>(), {
  legacy: false,
})

const { t } = useI18n()
const auth = useAuthStore()

const invitations = ref<InvitationSummary[]>([])
const credits = ref<InvitationCredits | null>(null)
const loading = ref(true)
const creating = ref(false)
const revokingId = ref<string | null>(null)
const error = ref('')
const copiedId = ref<string | null>(null)

const uses = ref(1)
const expiresInDays = ref<number | null>(7)
const autoFollow = ref(true)

const canCreate = computed(() => {
  const available = credits.value?.available_credits ?? 0
  return Boolean(
    credits.value?.can_issue_links
    && uses.value >= 1
    && uses.value <= available,
  )
})

const contributionProgress = computed(() => {
  if (!credits.value || credits.value.contribution_threshold <= 0) return 0
  const score = Math.max(0, credits.value.contribution_score)
  return Math.min(100, (score % credits.value.contribution_threshold) * 100 / credits.value.contribution_threshold)
})

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : t('invitations.never_expires')
}

function isExpired(value: string | null): boolean {
  return value !== null && new Date(value).getTime() <= Date.now()
}

async function loadInvitations() {
  if (!auth.token) return
  loading.value = true
  error.value = ''
  try {
    const [invitationResponse, creditResponse] = await Promise.all([
      listInvitations(auth.token),
      getInvitationCredits(auth.token),
    ])
    invitations.value = invitationResponse.data
    credits.value = creditResponse.data
    if (uses.value > creditResponse.data.available_credits) {
      uses.value = Math.max(1, creditResponse.data.available_credits)
    }
  } catch (requestError) {
    error.value = getApiErrorMessage(requestError, t('common.error'))
  } finally {
    loading.value = false
  }
}

async function handleCreate() {
  if (!auth.token || !canCreate.value) return
  creating.value = true
  error.value = ''
  copiedId.value = null
  try {
    await createInvitation(auth.token, {
      uses: Math.trunc(uses.value),
      expires_in_days: expiresInDays.value,
      auto_follow: autoFollow.value,
    })
    await loadInvitations()
  } catch (requestError) {
    error.value = getApiErrorMessage(requestError, t('common.error'))
  } finally {
    creating.value = false
  }
}

async function copyInvitationLink(invitation: InvitationSummary) {
  try {
    await navigator.clipboard.writeText(invitation.url)
    copiedId.value = invitation.id
  } catch (requestError) {
    error.value = getApiErrorMessage(requestError, t('common.error'))
  }
}

async function handleRevoke(invitation: InvitationSummary) {
  if (!auth.token || !window.confirm(t('invitations.revoke_confirm'))) return
  revokingId.value = invitation.id
  error.value = ''
  try {
    await revokeInvitation(auth.token, invitation.id)
    invitations.value = invitations.value.filter((item) => item.id !== invitation.id)
    if (copiedId.value === invitation.id) copiedId.value = null
    await loadInvitations()
  } catch (requestError) {
    error.value = getApiErrorMessage(requestError, t('common.error'))
  } finally {
    revokingId.value = null
  }
}

onMounted(loadInvitations)
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 :class="legacy ? 'text-2xl font-bold' : 'sb-heading text-2xl'">
        {{ t('invitations.title') }}
      </h1>
      <p :class="legacy ? 'mt-2 text-sm text-gray-500 dark:text-gray-400' : 'mt-2 text-sm text-slate-500 dark:text-slate-400'">
        {{ t('invitations.description') }}
      </p>
    </div>

    <div v-if="error" :class="legacy ? 'rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400' : 'rounded-xl bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400'" role="alert">
      {{ error }}
    </div>

    <section
      v-if="credits"
      :class="legacy ? 'rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800' : 'sb-card p-5'"
    >
      <h2 :class="legacy ? 'text-lg font-semibold' : 'sb-heading text-lg'">
        {{ t('invitations.credit_summary') }}
      </h2>
      <dl class="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <dt class="text-xs text-slate-500 dark:text-slate-400">{{ t('invitations.available_credits') }}</dt>
          <dd class="mt-1 text-2xl font-bold">{{ credits.available_credits }}</dd>
        </div>
        <div>
          <dt class="text-xs text-slate-500 dark:text-slate-400">{{ t('invitations.owned_credits') }}</dt>
          <dd class="mt-1 text-2xl font-bold">{{ credits.owned_credits }} / {{ credits.max_credits }}</dd>
        </div>
        <div>
          <dt class="text-xs text-slate-500 dark:text-slate-400">{{ t('invitations.reserved_credits') }}</dt>
          <dd class="mt-1 text-2xl font-bold">{{ credits.reserved_credits }}</dd>
          <p v-if="credits.pending_refund_credits > 0" class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {{ t('invitations.pending_refund_credits', { count: credits.pending_refund_credits }) }}
          </p>
        </div>
        <div>
          <dt class="text-xs text-slate-500 dark:text-slate-400">{{ t('invitations.contribution_score') }}</dt>
          <dd class="mt-1 text-2xl font-bold">{{ credits.contribution_score }}</dd>
        </div>
        <div>
          <dt class="text-xs text-slate-500 dark:text-slate-400">{{ t('invitations.next_credit') }}</dt>
          <dd class="mt-1 text-sm font-semibold">
            {{ credits.contribution_enabled ? t('invitations.threshold_points', { count: credits.contribution_threshold }) : t('invitations.contribution_disabled') }}
          </dd>
          <div v-if="credits.contribution_enabled && credits.contribution_threshold > 0" class="mt-2 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
            <div class="h-full rounded-full bg-indigo-600" :style="{ width: `${contributionProgress}%` }" />
          </div>
        </div>
      </dl>
    </section>

    <div
      v-if="credits && !credits.issuance_enabled && !credits.can_issue_links"
      class="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
      role="status"
    >
      {{ t('invitations.issuance_disabled') }}
    </div>

    <form
      :class="legacy ? 'space-y-4 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800' : 'sb-card space-y-5 p-5'"
      @submit.prevent="handleCreate"
    >
      <h2 :class="legacy ? 'text-lg font-semibold' : 'sb-heading text-lg'">
        {{ t('invitations.create') }}
      </h2>

      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <label for="invitation-uses" :class="legacy ? 'mb-1 block text-sm font-medium' : 'sb-label'">
            {{ t('invitations.uses') }}
          </label>
          <input
            id="invitation-uses"
            v-model.number="uses"
            type="number"
            min="1"
            :max="credits?.available_credits ?? 0"
            required
            :class="legacy ? 'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-700' : 'sb-input'"
          />
        </div>

        <div>
          <label for="invitation-expiry" :class="legacy ? 'mb-1 block text-sm font-medium' : 'sb-label'">
            {{ t('invitations.expiration') }}
          </label>
          <select
            id="invitation-expiry"
            v-model="expiresInDays"
            :class="legacy ? 'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-700' : 'sb-input'"
          >
            <option :value="1">{{ t('invitations.expires_1_day') }}</option>
            <option :value="7">{{ t('invitations.expires_7_days') }}</option>
            <option :value="30">{{ t('invitations.expires_30_days') }}</option>
            <option :value="null">{{ t('invitations.never_expires') }}</option>
          </select>
        </div>
      </div>

      <label class="flex cursor-pointer items-start gap-2.5">
        <input v-model="autoFollow" type="checkbox" class="mt-0.5 h-4 w-4 rounded accent-indigo-600" />
        <span :class="legacy ? 'text-sm text-gray-600 dark:text-gray-400' : 'text-sm text-slate-600 dark:text-slate-400'">
          {{ t('invitations.auto_follow') }}
        </span>
      </label>

      <button
        type="submit"
        :disabled="creating || !canCreate"
        :class="legacy ? 'rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white disabled:opacity-50' : 'sb-btn sb-btn-primary'"
      >
        {{ creating ? t('common.loading') : t('invitations.create') }}
      </button>
      <p v-if="credits && uses > credits.available_credits" class="text-sm text-red-600 dark:text-red-400">
        {{ t('invitations.insufficient_credits') }}
      </p>
    </form>

    <section>
      <h2 :class="legacy ? 'mb-3 text-lg font-semibold' : 'sb-heading mb-3 text-lg'">
        {{ t('invitations.active_links') }}
      </h2>

      <p v-if="loading" :class="legacy ? 'py-8 text-center text-sm text-gray-500 dark:text-gray-400' : 'py-8 text-center text-sm text-slate-500 dark:text-slate-400'">
        {{ t('common.loading') }}
      </p>
      <p v-else-if="invitations.length === 0" :class="legacy ? 'rounded-xl border border-gray-200 p-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400' : 'sb-empty'">
        {{ t('invitations.empty') }}
      </p>
      <div v-else class="space-y-3">
        <article
          v-for="invitation in invitations"
          :key="invitation.id"
          :class="legacy ? 'rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800' : 'sb-card p-4'"
        >
          <div class="mb-4 flex flex-col gap-2 sm:flex-row">
            <input
              :value="invitation.url"
              type="text"
              readonly
              :aria-label="t('invitations.copy_link')"
              :class="legacy ? 'min-w-0 flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900' : 'sb-input min-w-0 flex-1'"
              @focus="($event.target as HTMLInputElement).select()"
            />
            <button
              type="button"
              :class="legacy ? 'rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold dark:border-gray-600' : 'sb-btn sb-btn-secondary'"
              @click="copyInvitationLink(invitation)"
            >
              {{ copiedId === invitation.id ? t('invitations.copied') : t('invitations.copy_link') }}
            </button>
          </div>
          <div class="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <dl class="grid min-w-0 flex-1 gap-x-5 gap-y-2 text-sm sm:grid-cols-2">
              <div>
                <dt :class="legacy ? 'text-xs text-gray-500 dark:text-gray-400' : 'text-xs text-slate-500 dark:text-slate-400'">
                  {{ t('invitations.uses_remaining') }}
                </dt>
                <dd class="mt-0.5 font-semibold">{{ invitation.uses_remaining }}</dd>
              </div>
              <div>
                <dt :class="legacy ? 'text-xs text-gray-500 dark:text-gray-400' : 'text-xs text-slate-500 dark:text-slate-400'">
                  {{ t('invitations.issued_uses') }}
                </dt>
                <dd class="mt-0.5 font-semibold">{{ invitation.issued_uses }}</dd>
              </div>
              <div>
                <dt :class="legacy ? 'text-xs text-gray-500 dark:text-gray-400' : 'text-xs text-slate-500 dark:text-slate-400'">
                  {{ t('invitations.expires_at') }}
                </dt>
                <dd class="mt-0.5 font-medium" :class="{ 'text-red-600 dark:text-red-400': isExpired(invitation.expires_at) }">
                  {{ formatDate(invitation.expires_at) }}
                </dd>
              </div>
              <div>
                <dt :class="legacy ? 'text-xs text-gray-500 dark:text-gray-400' : 'text-xs text-slate-500 dark:text-slate-400'">
                  {{ t('invitations.created_at') }}
                </dt>
                <dd class="mt-0.5 font-medium">{{ formatDate(invitation.created_at) }}</dd>
              </div>
              <div>
                <dt :class="legacy ? 'text-xs text-gray-500 dark:text-gray-400' : 'text-xs text-slate-500 dark:text-slate-400'">
                  {{ t('invitations.auto_follow_label') }}
                </dt>
                <dd class="mt-0.5 font-medium">{{ invitation.auto_follow ? t('common.yes') : t('common.no') }}</dd>
              </div>
            </dl>
            <button
              type="button"
              :disabled="revokingId === invitation.id"
              :class="legacy ? 'rounded-lg border border-red-300 px-3 py-2 text-sm font-semibold text-red-600 disabled:opacity-50 dark:border-red-700 dark:text-red-400' : 'sb-btn border border-red-200 text-red-600 disabled:opacity-50 dark:border-red-900/60 dark:text-red-400'"
              @click="handleRevoke(invitation)"
            >
              {{ revokingId === invitation.id ? t('common.loading') : t('invitations.revoke') }}
            </button>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>
