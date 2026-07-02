<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { apiFetch, buildQueryString } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import AppShell from '@/components/layout/AppShell.vue';

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
      <header class="sb-glass sticky top-0 z-10 border-b px-4 py-3">
        <h1 class="sb-heading text-lg">{{ t('discovery.directory') }}</h1>
        <p class="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
          {{ t('discovery.directory_description') }}
        </p>
      </header>

      <div class="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-4">
        <select
          v-model="order"
          class="sb-input w-auto pr-9"
        >
          <option value="active">{{ t('discovery.directory_order_active') }}</option>
          <option value="new">{{ t('discovery.directory_order_new') }}</option>
        </select>
        <label class="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-600 dark:text-slate-300">
          <input
            v-model="localOnly"
            type="checkbox"
            class="h-4 w-4 rounded border-outline accent-brand-600 dark:border-outline-dark"
          />
          {{ t('discovery.directory_local_only') }}
        </label>
      </div>

      <div v-if="loading" class="sb-empty">
        {{ t('common.loading') }}
      </div>

      <div v-else class="grid grid-cols-1 gap-3 px-4 pb-6 sm:grid-cols-2">
        <router-link
          v-for="account in accounts"
          :key="account.id"
          :to="`/@${account.acct}`"
          class="sb-card sb-card-hover flex items-center gap-3 p-4"
        >
          <img
            :src="account.avatar"
            :alt="account.display_name || account.username"
            class="h-12 w-12 shrink-0 rounded-full object-cover"
          />
          <div class="min-w-0 flex-1">
            <div class="truncate font-semibold text-slate-900 dark:text-slate-100">
              {{ account.display_name || account.username }}
            </div>
            <div class="truncate text-sm text-slate-500 dark:text-slate-400">
              @{{ account.acct }}
            </div>
          </div>
        </router-link>
      </div>
    </div>
  </AppShell>
</template>
