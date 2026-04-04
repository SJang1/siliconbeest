<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { getAdminAccounts, changeRole, sendAdminEmail } from '@/api/mastodon/admin'
import { apiFetch } from '@/api/client'
import AdminLayout from '@/components/layout/AdminLayout.vue'

const { t } = useI18n()
const auth = useAuthStore()

interface AdminAccount {
  id: string
  username: string
  email: string
  role: string | { name: string } | null
  domain: string | null
  created_at: string
  disabled: boolean
  approved: boolean
  silenced: boolean
  suspended: boolean
  confirmed: boolean
  invite_request: string | null
}

const accounts = ref<AdminAccount[]>([])
const loading = ref(true)
const error = ref('')
const filter = ref<'all' | 'local' | 'remote' | 'pending'>('all')
const actionMessage = ref('')

// Email modal state
const emailModalOpen = ref(false)
const emailTarget = ref<AdminAccount | null>(null)
const emailSubject = ref('')
const emailBody = ref('')
const emailSending = ref(false)

const filteredAccounts = computed(() => {
  switch (filter.value) {
    case 'local':
      return accounts.value.filter((a) => !a.domain)
    case 'remote':
      return accounts.value.filter((a) => !!a.domain)
    case 'pending':
      return accounts.value.filter((a) => !a.approved)
    default:
      return accounts.value
  }
})

onMounted(() => loadAccounts())

async function loadAccounts() {
  loading.value = true
  error.value = ''
  try {
    const params: Record<string, string> = {}
    if (filter.value === 'local') params.local = 'true'
    if (filter.value === 'remote') params.remote = 'true'
    if (filter.value === 'pending') params.pending = 'true'
    const { data } = await getAdminAccounts(auth.token!, params)
    accounts.value = data as AdminAccount[]
  } catch (e: any) {
    error.value = e?.description || e?.error || t('common.error')
  } finally {
    loading.value = false
  }
}

async function handleRoleChange(account: AdminAccount, newRole: string) {
  actionMessage.value = ''
  try {
    await changeRole(auth.token!, account.id, newRole)
    account.role = newRole
    actionMessage.value = t('admin_accounts.role_changed')
  } catch (e: any) {
    actionMessage.value = e?.description || e?.error || t('common.error')
  }
}

async function handleAction(account: AdminAccount, action: string) {
  actionMessage.value = ''
  try {
    await apiFetch(`/v1/admin/accounts/${account.id}/${action}`, {
      method: 'POST',
      token: auth.token!,
    })
    if (action === 'approve') {
      account.approved = true
      actionMessage.value = t('admin_accounts.approved')
    } else if (action === 'reject') {
      accounts.value = accounts.value.filter((a) => a.id !== account.id)
      actionMessage.value = t('admin_accounts.rejected')
    } else if (action === 'unsuspend') {
      actionMessage.value = t('admin_accounts.unsuspended')
      await loadAccounts()
    } else if (action === 'unsilence') {
      actionMessage.value = t('admin_accounts.unsilenced')
      await loadAccounts()
    } else if (action === 'enable') {
      actionMessage.value = t('admin_accounts.enabled')
      await loadAccounts()
    } else if (action === 'unsensitize') {
      actionMessage.value = t('admin_accounts.unsensitized')
      await loadAccounts()
    } else {
      await loadAccounts()
    }
  } catch (e: any) {
    actionMessage.value = e?.description || e?.error || t('common.error')
  }
}

function openEmailModal(account: AdminAccount) {
  emailTarget.value = account
  emailSubject.value = ''
  emailBody.value = ''
  emailModalOpen.value = true
}

async function handleSendEmail() {
  if (!emailTarget.value) return
  emailSending.value = true
  try {
    await sendAdminEmail(auth.token!, emailTarget.value.email, emailSubject.value, emailBody.value)
    emailModalOpen.value = false
  } catch (e: any) {
    actionMessage.value = e?.description || e?.error || t('common.error')
  } finally {
    emailSending.value = false
  }
}

function changeFilter(f: 'all' | 'local' | 'remote' | 'pending') {
  filter.value = f
  loadAccounts()
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString()
}

function statusBadge(account: AdminAccount) {
  if (account.suspended) return { text: 'Suspended', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' }
  if (account.silenced) return { text: 'Silenced', color: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' }
  if (!account.approved) return { text: 'Pending', color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' }
  if (account.disabled) return { text: 'Disabled', color: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-400' }
  return { text: 'Active', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' }
}

const tabClass = (active: boolean) =>
  active
    ? 'px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white'
    : 'px-4 py-2 text-sm font-medium rounded-lg text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'

const inputClass = 'w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500'
</script>

<template>
  <AdminLayout>
  <div class="w-full">
    <h1 class="text-2xl font-bold mb-6">{{ t('admin.accounts') }}</h1>

    <!-- Filter tabs -->
    <div class="flex gap-2 mb-4">
      <button :class="tabClass(filter === 'all')" @click="changeFilter('all')">{{ t('admin_accounts.filter_all') }}</button>
      <button :class="tabClass(filter === 'local')" @click="changeFilter('local')">{{ t('admin_accounts.filter_local') }}</button>
      <button :class="tabClass(filter === 'remote')" @click="changeFilter('remote')">{{ t('admin_accounts.filter_remote') }}</button>
      <button :class="tabClass(filter === 'pending')" @click="changeFilter('pending')">{{ t('admin_accounts.filter_pending') }}</button>
    </div>

    <!-- Messages -->
    <div v-if="actionMessage" class="mb-4 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 text-sm">
      {{ actionMessage }}
    </div>
    <div v-if="error" class="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm" role="alert">
      {{ error }}
    </div>

    <!-- Loading -->
    <div v-if="loading" class="text-gray-500">{{ t('common.loading') }}</div>

    <!-- Table -->
    <div v-else class="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-gray-200 dark:border-gray-700 text-left">
            <th class="px-4 py-3 font-medium">{{ t('auth.username') }}</th>
            <th class="px-4 py-3 font-medium">{{ t('auth.email') }}</th>
            <th class="px-4 py-3 font-medium">{{ t('admin_accounts.role') }}</th>
            <th class="px-4 py-3 font-medium">Status</th>
            <th class="px-4 py-3 font-medium">Created</th>
            <th class="px-4 py-3 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="account in filteredAccounts"
            :key="account.id"
            class="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30"
          >
            <td class="px-4 py-3">
              <div class="font-medium">
                {{ account.username }}
                <span v-if="account.domain" class="text-gray-400">@{{ account.domain }}</span>
              </div>
              <div v-if="!account.approved && account.invite_request" class="mt-1 text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-700/50 rounded px-2 py-1">
                <span class="font-medium text-gray-600 dark:text-gray-300">{{ t('auth.signup_reason') }}</span>
                {{ account.invite_request }}
              </div>
            </td>
            <td class="px-4 py-3 text-gray-600 dark:text-gray-400">{{ account.email || '-' }}</td>
            <td class="px-4 py-3">
              <select
                :value="typeof account.role === 'string' ? account.role : (account.role?.name || 'user')"
                @change="handleRoleChange(account, ($event.target as HTMLSelectElement).value)"
                class="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="user">user</option>
                <option value="moderator">moderator</option>
                <option value="admin">admin</option>
              </select>
            </td>
            <td class="px-4 py-3">
              <span class="px-2 py-0.5 rounded-full text-xs font-medium" :class="statusBadge(account).color">
                {{ statusBadge(account).text }}
              </span>
            </td>
            <td class="px-4 py-3 text-gray-600 dark:text-gray-400">{{ formatDate(account.created_at) }}</td>
            <td class="px-4 py-3">
              <div class="flex gap-1 flex-wrap">
                <template v-if="!account.approved">
                  <button
                    @click="handleAction(account, 'approve')"
                    class="px-2 py-1 text-xs rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50"
                  >
                    {{ t('admin_accounts.approve') }}
                  </button>
                  <button
                    @click="handleAction(account, 'reject')"
                    class="px-2 py-1 text-xs rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50"
                  >
                    {{ t('admin_accounts.reject') }}
                  </button>
                </template>
                <template v-else>
                  <button
                    v-if="account.suspended"
                    @click="handleAction(account, 'unsuspend')"
                    class="px-2 py-1 text-xs rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50"
                  >
                    {{ t('admin_accounts.unsuspend') }}
                  </button>
                  <button
                    v-if="account.silenced"
                    @click="handleAction(account, 'unsilence')"
                    class="px-2 py-1 text-xs rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50"
                  >
                    {{ t('admin_accounts.unsilence') }}
                  </button>
                  <button
                    v-if="account.disabled"
                    @click="handleAction(account, 'enable')"
                    class="px-2 py-1 text-xs rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50"
                  >
                    {{ t('admin_accounts.enable') }}
                  </button>
                  <button
                    v-if="!account.silenced && !account.suspended"
                    @click="handleAction(account, 'silence')"
                    class="px-2 py-1 text-xs rounded bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 hover:bg-yellow-200 dark:hover:bg-yellow-900/50"
                  >
                    {{ t('admin.accountAction.silence') }}
                  </button>
                  <button
                    v-if="!account.suspended"
                    @click="handleAction(account, 'suspend')"
                    class="px-2 py-1 text-xs rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50"
                  >
                    {{ t('admin.accountAction.suspend') }}
                  </button>
                </template>
                <button
                  v-if="account.email"
                  @click="openEmailModal(account)"
                  class="px-2 py-1 text-xs rounded bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400 hover:bg-indigo-200 dark:hover:bg-indigo-900/50"
                >
                  {{ t('admin_accounts.send_email') }}
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="filteredAccounts.length === 0">
            <td colspan="6" class="px-4 py-8 text-center text-gray-500">No accounts found.</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Email Modal -->
    <Teleport to="body">
      <div v-if="emailModalOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" @click.self="emailModalOpen = false">
        <div class="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 w-full max-w-md mx-4 border border-gray-200 dark:border-gray-700">
          <h3 class="text-lg font-semibold mb-4">
            {{ t('admin_accounts.send_email') }} - {{ emailTarget?.username }}
          </h3>
          <form @submit.prevent="handleSendEmail" class="space-y-4">
            <div>
              <label class="block text-sm font-medium mb-1">To</label>
              <input :value="emailTarget?.email" disabled :class="inputClass" class="!bg-gray-100 dark:!bg-gray-600" />
            </div>
            <div>
              <label class="block text-sm font-medium mb-1">Subject</label>
              <input v-model="emailSubject" required :class="inputClass" />
            </div>
            <div>
              <label class="block text-sm font-medium mb-1">Body</label>
              <textarea v-model="emailBody" required rows="5" :class="inputClass" />
            </div>
            <div class="flex justify-end gap-3">
              <button
                type="button"
                @click="emailModalOpen = false"
                class="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                {{ t('common.cancel') }}
              </button>
              <button
                type="submit"
                :disabled="emailSending"
                class="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold transition-colors disabled:opacity-50"
              >
                {{ emailSending ? t('common.loading') : t('admin_accounts.send_email') }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Teleport>
  </div>
  </AdminLayout>
</template>
