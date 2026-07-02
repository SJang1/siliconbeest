<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { apiFetch } from '@/api/client'
import AppShell from '@/components/layout/AppShell.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()
const auth = useAuthStore()

interface List {
  id: string
  title: string
  replies_policy: string
}

const lists = ref<List[]>([])
const loading = ref(true)
const newTitle = ref('')
const creating = ref(false)
const editingId = ref<string | null>(null)
const editTitle = ref('')

async function loadLists() {
  if (!auth.token) return
  loading.value = true
  try {
    const { data } = await apiFetch<List[]>('/v1/lists', { token: auth.token })
    lists.value = data
  } catch { /* ignore */ }
  loading.value = false
}

async function createList() {
  if (!auth.token || !newTitle.value.trim()) return
  creating.value = true
  try {
    const { data } = await apiFetch<List>('/v1/lists', {
      method: 'POST',
      body: JSON.stringify({ title: newTitle.value.trim() }),
      token: auth.token,
    })
    lists.value.unshift(data)
    newTitle.value = ''
  } catch { /* ignore */ }
  creating.value = false
}

function startEdit(list: List) {
  editingId.value = list.id
  editTitle.value = list.title
}

async function saveEdit(list: List) {
  if (!auth.token || !editTitle.value.trim()) return
  try {
    await apiFetch(`/v1/lists/${list.id}`, {
      method: 'PUT',
      body: JSON.stringify({ title: editTitle.value.trim() }),
      token: auth.token,
    })
    list.title = editTitle.value.trim()
  } catch { /* ignore */ }
  editingId.value = null
}

async function deleteList(id: string) {
  if (!auth.token || !confirm(t('lists.delete_confirm'))) return
  try {
    await apiFetch(`/v1/lists/${id}`, { method: 'DELETE', token: auth.token })
    lists.value = lists.value.filter(l => l.id !== id)
  } catch { /* ignore */ }
}

onMounted(loadLists)
</script>

<template>
  <AppShell>
    <div class="w-full">
      <header class="sb-glass sticky top-0 z-10 border-b px-4 py-3">
        <h1 class="sb-heading text-lg text-slate-900 dark:text-white">{{ t('nav.lists') }}</h1>
      </header>

      <!-- Create new list -->
      <form @submit.prevent="createList" class="flex items-center gap-2 border-b border-outline p-4 dark:border-outline-dark">
        <input
          v-model="newTitle"
          type="text"
          :placeholder="t('lists.new_placeholder')"
          class="sb-input flex-1"
        />
        <button
          type="submit"
          :disabled="!newTitle.trim() || creating"
          class="sb-btn sb-btn-primary shrink-0"
        >
          {{ t('lists.create') }}
        </button>
      </form>

      <LoadingSpinner v-if="loading" />

      <div v-else-if="lists.length === 0" class="sb-empty animate-fade-in px-4">
        <span class="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-300" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="h-6 w-6">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z" />
          </svg>
        </span>
        <p class="text-base font-semibold text-slate-700 dark:text-slate-200">{{ t('lists.empty') }}</p>
        <p class="text-sm">{{ t('lists.empty_hint') }}</p>
      </div>

      <ul v-else class="divide-y divide-outline dark:divide-outline-dark">
        <li v-for="list in lists" :key="list.id" class="flex items-center justify-between px-4 py-3 transition-colors hover:bg-surface-2/60 dark:hover:bg-surface-2-dark/60">
          <!-- Editing mode -->
          <form v-if="editingId === list.id" @submit.prevent="saveEdit(list)" class="flex flex-1 items-center gap-2">
            <input
              v-model="editTitle"
              class="sb-input flex-1 py-2"
              @keydown.esc="editingId = null"
            />
            <button type="submit" class="sb-btn sb-btn-primary sb-btn-sm shrink-0" :aria-label="t('common.save')">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="h-4 w-4" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
              </svg>
            </button>
            <button type="button" @click="editingId = null" class="sb-btn sb-btn-ghost sb-btn-sm shrink-0" :aria-label="t('common.cancel')">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="h-4 w-4" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </form>

          <!-- Display mode -->
          <router-link v-else :to="`/lists/${list.id}`" class="group flex min-w-0 flex-1 items-center gap-3 font-medium text-slate-900 transition-colors hover:text-brand-600 dark:text-slate-100 dark:hover:text-brand-400">
            <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 transition-colors group-hover:bg-brand-100 dark:bg-brand-950/60 dark:text-brand-300 dark:group-hover:bg-brand-900/60" aria-hidden="true">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="h-5 w-5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z" />
              </svg>
            </span>
            <span class="truncate">{{ list.title }}</span>
          </router-link>

          <div v-if="editingId !== list.id" class="ml-2 flex shrink-0 items-center gap-1">
            <button @click="startEdit(list)" class="rounded-full p-2 text-slate-400 transition-colors hover:bg-surface-2 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:hover:bg-surface-2-dark dark:hover:text-slate-200" :aria-label="t('common.edit')">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="h-4.5 w-4.5" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125" />
              </svg>
            </button>
            <button @click="deleteList(list.id)" class="rounded-full p-2 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 dark:hover:bg-red-950/40 dark:hover:text-red-400" :aria-label="t('common.delete')">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="h-4.5 w-4.5" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
              </svg>
            </button>
          </div>
        </li>
      </ul>
    </div>
  </AppShell>
</template>
