<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { apiFetch, buildQueryString } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import AppShell from '@/legacy/components/layout/AppShell.vue';

const { t } = useI18n();
const auth = useAuthStore();

const accounts = ref<any[]>([]);
const loading = ref(true);
const order = ref<'active' | 'new'>('active');
const localOnly = ref(true);

async function loadDirectory() {
  loading.value = true;
  try {
    const qs = buildQueryString({
      order: order.value,
      local: String(localOnly.value),
      limit: '40',
    });
    const { data } = await apiFetch<any[]>(`/v1/directory${qs}`, {
      token: auth.token ?? undefined,
    });
    accounts.value = data;
  } catch (e) {
    console.error('Failed to load directory:', e);
  } finally {
    loading.value = false;
  }
}

watch([order, localOnly], loadDirectory);
onMounted(loadDirectory);
</script>

<template>
  <AppShell>
    <div>
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <h1 class="text-xl font-bold">{{ t('discovery.directory') }}</h1>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {{ t('discovery.directory_description') }}
        </p>
      </header>

      <div class="flex gap-4 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <select
          v-model="order"
          class="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm"
        >
          <option value="active">{{ t('discovery.directory_order_active') }}</option>
          <option value="new">{{ t('discovery.directory_order_new') }}</option>
        </select>
        <label class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            v-model="localOnly"
            type="checkbox"
            class="rounded border-gray-300 dark:border-gray-600"
          />
          {{ t('discovery.directory_local_only') }}
        </label>
      </div>

      <div v-if="loading" class="text-center py-8 text-gray-500">
        {{ t('common.loading') }}
      </div>

      <div v-else class="divide-y divide-gray-200 dark:divide-gray-700">
        <router-link
          v-for="account in accounts"
          :key="account.id"
          :to="`/@${account.acct}`"
          class="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
        >
          <img
            :src="account.avatar"
            :alt="account.display_name || account.username"
            class="w-12 h-12 rounded-full object-cover"
          />
          <div class="flex-1 min-w-0">
            <div class="font-medium text-gray-900 dark:text-gray-100 truncate">
              {{ account.display_name || account.username }}
            </div>
            <div class="text-sm text-gray-500 dark:text-gray-400 truncate">
              @{{ account.acct }}
            </div>
          </div>
        </router-link>
      </div>
    </div>
  </AppShell>
</template>
