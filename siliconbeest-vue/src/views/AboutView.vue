<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Instance } from '@/types/mastodon'
import AppShell from '@/components/layout/AppShell.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()

const instanceInfo = ref<Instance | null>(null)
const loading = ref(true)

onMounted(async () => {
  try {
    // TODO: fetch from API
    // instanceInfo.value = await api.getInstance()
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <AppShell>
    <div>
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <h1 class="text-xl font-bold">{{ t('about.title') }}</h1>
      </header>

      <LoadingSpinner v-if="loading" />

      <div v-else class="p-6 space-y-6">
        <div class="text-center">
          <h2 class="text-2xl font-bold text-indigo-600 dark:text-indigo-400">SiliconBeest</h2>
          <p class="text-gray-500 dark:text-gray-400 mt-1">{{ t('about.description') }}</p>
        </div>

        <div v-if="instanceInfo" class="space-y-4">
          <div class="rounded-xl bg-gray-50 dark:bg-gray-800 p-4">
            <h3 class="font-semibold mb-2">{{ t('about.stats') }}</h3>
            <dl class="grid grid-cols-3 gap-4 text-center">
              <div>
                <dt class="text-xs text-gray-500 dark:text-gray-400">{{ t('about.users') }}</dt>
                <dd class="text-lg font-bold">{{ instanceInfo.usage?.users?.active_month ?? 0 }}</dd>
              </div>
            </dl>
          </div>

          <div v-if="instanceInfo.description" class="prose prose-sm dark:prose-invert max-w-none" v-html="instanceInfo.description" />

          <div class="rounded-xl bg-gray-50 dark:bg-gray-800 p-4">
            <h3 class="font-semibold mb-2">{{ t('about.contact') }}</h3>
            <p class="text-sm text-gray-600 dark:text-gray-400">
              {{ instanceInfo.contact?.account?.display_name ?? t('about.no_contact') }}
            </p>
          </div>
        </div>

        <div v-else class="text-center text-gray-500 dark:text-gray-400">
          {{ t('about.unavailable') }}
        </div>
      </div>
    </div>
  </AppShell>
</template>
