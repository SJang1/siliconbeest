<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { getRelays, addRelay as apiAddRelay, removeRelay as apiRemoveRelay } from '@/api/mastodon/admin';
import { useAuthStore } from '@/stores/auth';
import AdminLayout from '@/components/layout/AdminLayout.vue';

const { t } = useI18n();
const auth = useAuthStore();

interface Relay {
  id: string;
  inbox_url: string;
  state: string;
  created_at: string;
}

const relays = ref<Relay[]>([]);
const newInboxUrl = ref('');
const loading = ref(false);
const error = ref('');

async function fetchRelays() {
  loading.value = true;
  error.value = '';
  try {
    const res = await getRelays(auth.token!);
    relays.value = res.data;
  } catch (e: any) {
    error.value = e.message ?? t('common.error');
  } finally {
    loading.value = false;
  }
}

async function addRelay() {
  if (!newInboxUrl.value) return;
  loading.value = true;
  error.value = '';
  try {
    await apiAddRelay(auth.token!, newInboxUrl.value);
    newInboxUrl.value = '';
    await fetchRelays();
  } catch (e: any) {
    error.value = e.message ?? t('common.error');
  } finally {
    loading.value = false;
  }
}

async function removeRelay(id: string) {
  loading.value = true;
  error.value = '';
  try {
    await apiRemoveRelay(auth.token!, id);
    await fetchRelays();
  } catch (e: any) {
    error.value = e.message ?? t('common.error');
  } finally {
    loading.value = false;
  }
}

onMounted(fetchRelays);
</script>

<template>
  <AdminLayout>
  <div class="w-full max-w-5xl animate-fade-in">
    <h1 class="sb-heading mb-6 text-2xl text-slate-900 dark:text-white">{{ $t('admin.relays') }}</h1>

    <!-- Add relay form -->
    <div class="mb-6 flex gap-2">
      <input v-model="newInboxUrl"
             :placeholder="$t('admin.relayInboxPlaceholder')"
             class="sb-input flex-1" />
      <button @click="addRelay" :disabled="loading || !newInboxUrl"
              class="sb-btn sb-btn-primary shrink-0">
        {{ $t('admin.addRelay') }}
      </button>
    </div>

    <!-- Error message -->
    <p v-if="error" class="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">{{ error }}</p>

    <!-- Relay list -->
    <div v-if="relays.length === 0 && !loading" class="sb-card">
      <div class="sb-empty">
        {{ $t('admin.noRelays') }}
      </div>
    </div>

    <div v-else-if="relays.length > 0" class="sb-card divide-y divide-outline overflow-hidden dark:divide-outline-dark">
      <div v-for="relay in relays" :key="relay.id"
           class="flex items-center justify-between gap-3 p-4 transition-colors hover:bg-surface-2/70 dark:hover:bg-surface-2-dark/70">
        <div class="min-w-0">
          <div class="truncate font-mono text-sm text-slate-900 dark:text-white">{{ relay.inbox_url }}</div>
          <div class="mt-1.5 flex items-center gap-2 text-xs">
            <span class="sb-chip" :class="{
              'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300': relay.state === 'accepted',
              'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300': relay.state === 'pending',
              'bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300': relay.state === 'rejected',
              'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300': relay.state === 'idle',
            }">
              {{ $t('admin.relayState.' + relay.state) }}
            </span>
            <span class="text-slate-400 dark:text-slate-500">{{ new Date(relay.created_at).toLocaleDateString() }}</span>
          </div>
        </div>
        <button @click="removeRelay(relay.id)"
                class="sb-btn sb-btn-ghost sb-btn-sm shrink-0 text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40 dark:hover:text-red-300">
          {{ $t('common.delete') }}
        </button>
      </div>
    </div>
  </div>
  </AdminLayout>
</template>
