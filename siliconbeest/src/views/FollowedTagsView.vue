<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { apiFetch } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import AppShell from '@/components/layout/AppShell.vue';

const { t } = useI18n();
const auth = useAuthStore();

interface FollowedTag {
  name: string;
  url: string;
  following: boolean;
}

const tags = ref<FollowedTag[]>([]);
const loading = ref(true);

async function loadTags() {
  loading.value = true;
  try {
    const { data } = await apiFetch<FollowedTag[]>('/v1/followed_tags', {
      token: auth.token ?? undefined,
    });
    tags.value = data;
  } catch (e) {
    console.error('Failed to load followed tags:', e);
  } finally {
    loading.value = false;
  }
}

async function unfollowTag(tagName: string) {
  try {
    await apiFetch(`/v1/tags/${tagName}/unfollow`, {
      token: auth.token ?? undefined,
      method: 'POST',
    });
    tags.value = tags.value.filter((t) => t.name !== tagName);
  } catch (e) {
    console.error('Failed to unfollow tag:', e);
  }
}

onMounted(loadTags);
</script>

<template>
  <AppShell>
    <div>
      <header class="sb-glass sticky top-0 z-10 border-b px-4 py-3">
        <h1 class="sb-heading text-lg">{{ t('discovery.followed_tags') }}</h1>
      </header>

      <div v-if="loading" class="sb-empty">
        {{ t('common.loading') }}
      </div>

      <div v-else-if="tags.length === 0" class="sb-empty">
        <svg class="h-8 w-8 text-slate-300 dark:text-slate-600" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5.25 8.25h13.5m-14.25 7.5h13.5m-9-15L7.5 20.25m9-19.5l-2.25 19.5" />
        </svg>
        {{ t('discovery.followed_tags_empty') }}
      </div>

      <div v-else class="p-4">
        <ul class="sb-card divide-y divide-outline overflow-hidden dark:divide-outline-dark">
          <li
            v-for="tag in tags"
            :key="tag.name"
            class="flex items-center justify-between gap-3 px-4 py-3"
          >
            <router-link
              :to="`/tags/${tag.name}`"
              class="sb-chip min-w-0 px-3 py-1 text-sm font-semibold transition-colors hover:bg-brand-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:hover:bg-brand-900/60"
            >
              <span class="truncate">#{{ tag.name }}</span>
            </router-link>
            <button
              class="sb-btn sb-btn-secondary sb-btn-sm shrink-0"
              @click="unfollowTag(tag.name)"
            >
              {{ t('discovery.unfollow_tag') }}
            </button>
          </li>
        </ul>
      </div>
    </div>
  </AppShell>
</template>
