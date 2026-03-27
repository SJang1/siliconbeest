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
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <h1 class="text-xl font-bold text-gray-900 dark:text-white">{{ t('nav.lists') }}</h1>
      </header>

      <!-- Create new list -->
      <form @submit.prevent="createList" class="p-4 border-b border-gray-200 dark:border-gray-700 flex gap-2">
        <input
          v-model="newTitle"
          type="text"
          :placeholder="t('lists.new_placeholder')"
          class="flex-1 px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-transparent dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <button
          type="submit"
          :disabled="!newTitle.trim() || creating"
          class="px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {{ t('lists.create') }}
        </button>
      </form>

      <LoadingSpinner v-if="loading" />

      <div v-else-if="lists.length === 0" class="p-8 text-center text-gray-500 dark:text-gray-400">
        <p class="text-lg font-medium">{{ t('lists.empty') }}</p>
        <p class="text-sm mt-1">{{ t('lists.empty_hint') }}</p>
      </div>

      <ul v-else class="divide-y divide-gray-200 dark:divide-gray-700">
        <li v-for="list in lists" :key="list.id" class="flex items-center justify-between px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
          <!-- Editing mode -->
          <form v-if="editingId === list.id" @submit.prevent="saveEdit(list)" class="flex-1 flex gap-2">
            <input
              v-model="editTitle"
              class="flex-1 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-transparent dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              @keydown.esc="editingId = null"
            />
            <button type="submit" class="px-3 py-1.5 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">✓</button>
            <button type="button" @click="editingId = null" class="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">✕</button>
          </form>

          <!-- Display mode -->
          <router-link v-else :to="`/lists/${list.id}`" class="flex-1 text-gray-900 dark:text-white font-medium hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors">
            📋 {{ list.title }}
          </router-link>

          <div v-if="editingId !== list.id" class="flex items-center gap-1 ml-2">
            <button @click="startEdit(list)" class="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors" :aria-label="t('common.edit')">
              ✏️
            </button>
            <button @click="deleteList(list.id)" class="p-1.5 text-gray-400 hover:text-red-500 transition-colors" :aria-label="t('common.delete')">
              🗑️
            </button>
          </div>
        </li>
      </ul>
    </div>
  </AppShell>
</template>
