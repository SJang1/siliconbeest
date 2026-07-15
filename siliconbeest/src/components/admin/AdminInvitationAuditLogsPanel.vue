<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { getInvitationAuditLogs } from '@/api/mastodon/invitations'
import { getApiErrorMessage } from '@/utils/apiError'
import { withCurrentDesign } from '@/utils/safeRedirect'
import type { InvitationAuditLog } from '@/types/registration'

const { t } = useI18n()
const route = useRoute()
const auth = useAuthStore()
const PAGE_SIZE = 50

const logs = ref<InvitationAuditLog[]>([])
const total = ref(0)
const offset = ref(0)
const loading = ref(true)
const error = ref('')

const hasPrevious = computed(() => offset.value > 0)
const hasNext = computed(() => offset.value + logs.value.length < total.value)

function formatDate(value: string): string {
  return new Date(value).toLocaleString()
}

function formatDelta(value: number | null): string {
  if (value === null) return '—'
  return value > 0 ? `+${value}` : String(value)
}

async function loadLogs(nextOffset = offset.value) {
  if (!auth.token) return
  loading.value = true
  error.value = ''
  try {
    const { data } = await getInvitationAuditLogs(auth.token, {
      limit: PAGE_SIZE,
      offset: nextOffset,
    })
    logs.value = data.logs
    total.value = data.total
    offset.value = data.offset
  } catch (requestError) {
    error.value = getApiErrorMessage(requestError, t('common.error'))
  } finally {
    loading.value = false
  }
}

onMounted(() => loadLogs(0))
</script>

<template>
  <div class="w-full max-w-7xl space-y-6">
    <header class="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
      <div>
        <h1 class="sb-heading text-2xl">{{ t('admin_invitation_audit.title') }}</h1>
        <p class="mt-2 text-sm text-slate-500 dark:text-slate-400">{{ t('admin_invitation_audit.description') }}</p>
      </div>
      <router-link class="sb-btn sb-btn-secondary shrink-0" :to="withCurrentDesign('/admin/invitation-credits', route.path)">
        {{ t('admin_invitation_audit.manage_credits') }}
      </router-link>
    </header>

    <div v-if="error" class="rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300" role="alert">
      {{ error }}
    </div>

    <section class="sb-card overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full min-w-[1050px] text-left text-sm">
          <thead class="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/70 dark:text-slate-400">
            <tr>
              <th class="px-4 py-3">{{ t('admin_invitation_audit.time') }}</th>
              <th class="px-4 py-3">{{ t('admin_invitation_audit.action') }}</th>
              <th class="px-4 py-3">{{ t('admin_invitation_audit.actor') }}</th>
              <th class="px-4 py-3">{{ t('admin_invitation_audit.target') }}</th>
              <th class="px-4 py-3">{{ t('admin_invitation_audit.credit_delta') }}</th>
              <th class="px-4 py-3">{{ t('admin_invitation_audit.contribution_delta') }}</th>
              <th class="px-4 py-3">{{ t('admin_invitation_audit.reason') }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-200 dark:divide-slate-700">
            <tr v-if="loading">
              <td class="px-4 py-10 text-center text-slate-500" colspan="7">{{ t('common.loading') }}</td>
            </tr>
            <tr v-else-if="logs.length === 0">
              <td class="px-4 py-10 text-center text-slate-500" colspan="7">{{ t('admin_invitation_audit.empty') }}</td>
            </tr>
            <tr v-for="log in logs" v-else :key="log.id">
              <td class="whitespace-nowrap px-4 py-3">{{ formatDate(log.created_at) }}</td>
              <td class="px-4 py-3">
                <span class="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold dark:bg-slate-800">{{ log.action }}</span>
                <div v-if="log.invitation_id" class="mt-1 text-xs text-slate-500">{{ log.invitation_id }}</div>
              </td>
              <td class="px-4 py-3">{{ log.actor_username ? `@${log.actor_username}` : t('admin_invitation_audit.system') }}</td>
              <td class="px-4 py-3">{{ log.target_username ? `@${log.target_username}` : '—' }}</td>
              <td class="px-4 py-3 font-semibold" :class="(log.credit_delta ?? 0) < 0 ? 'text-red-600' : 'text-emerald-600'">
                {{ formatDelta(log.credit_delta) }}
              </td>
              <td class="px-4 py-3 font-semibold" :class="(log.contribution_delta ?? 0) < 0 ? 'text-red-600' : 'text-emerald-600'">
                {{ formatDelta(log.contribution_delta) }}
              </td>
              <td class="max-w-xs px-4 py-3 text-slate-600 dark:text-slate-300">{{ log.reason || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm dark:border-slate-700">
        <span>{{ t('admin_invitation_audit.total', { count: total }) }}</span>
        <div class="flex gap-2">
          <button class="sb-btn sb-btn-secondary" type="button" :disabled="!hasPrevious || loading" @click="loadLogs(Math.max(0, offset - PAGE_SIZE))">
            {{ t('common.previous') }}
          </button>
          <button class="sb-btn sb-btn-secondary" type="button" :disabled="!hasNext || loading" @click="loadLogs(offset + PAGE_SIZE)">
            {{ t('common.next') }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>
