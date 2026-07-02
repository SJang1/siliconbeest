<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { apiFetch } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import AppShell from '@/legacy/components/layout/AppShell.vue';

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
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <h1 class="text-xl font-bold">{{ t('discovery.followed_tags') }}</h1>
      </header>

      <div v-if="loading" class="text-center py-8 text-gray-500">
        {{ t('common.loading') }}
      </div>

      <div v-else-if="tags.length === 0" class="text-center py-8 text-gray-500 dark:text-gray-400">
        {{ t('discovery.followed_tags_empty') }}
      </div>

      <ul v-else class="divide-y divide-gray-200 dark:divide-gray-700">
        <li
          v-for="tag in tags"
          :key="tag.name"
          class="flex items-center justify-between px-4 py-3"
        >
          <router-link
            :to="`/tags/${tag.name}`"
            class="text-lg font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            #{{ tag.name }}
          </router-link>
          <button
            class="px-3 py-1.5 text-sm rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            @click="unfollowTag(tag.name)"
          >
            {{ t('discovery.unfollow_tag') }}
          </button>
        </li>
      </ul>
    </div>
  </AppShell>
</template>
