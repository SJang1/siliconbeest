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
  <div class="w-full p-4">
    <h1 class="text-2xl font-bold mb-6">{{ $t('admin.relays') }}</h1>

    <!-- Add relay form -->
    <div class="mb-6 flex gap-2">
      <input v-model="newInboxUrl"
             :placeholder="$t('admin.relayInboxPlaceholder')"
             class="flex-1 rounded-lg border px-3 py-2 dark:bg-gray-800 dark:border-gray-700" />
      <button @click="addRelay" :disabled="loading || !newInboxUrl"
              class="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
        {{ $t('admin.addRelay') }}
      </button>
    </div>

    <!-- Error message -->
    <p v-if="error" class="text-red-500 mb-4">{{ error }}</p>

    <!-- Relay list -->
    <div v-if="relays.length === 0 && !loading" class="text-gray-500 py-8 text-center">
      {{ $t('admin.noRelays') }}
    </div>

    <div v-for="relay in relays" :key="relay.id"
         class="flex items-center justify-between p-4 border rounded-lg mb-2 dark:border-gray-700">
      <div>
        <div class="font-mono text-sm">{{ relay.inbox_url }}</div>
        <div class="text-xs mt-1">
          <span :class="{
            'text-green-500': relay.state === 'accepted',
            'text-yellow-500': relay.state === 'pending',
            'text-red-500': relay.state === 'rejected',
            'text-gray-500': relay.state === 'idle',
          }">
            {{ $t('admin.relayState.' + relay.state) }}
          </span>
          <span class="text-gray-400 ml-2">{{ new Date(relay.created_at).toLocaleDateString() }}</span>
        </div>
      </div>
      <button @click="removeRelay(relay.id)"
              class="text-red-500 hover:text-red-700 text-sm">
        {{ $t('common.delete') }}
      </button>
    </div>
  </div>
  </AdminLayout>
</template>
