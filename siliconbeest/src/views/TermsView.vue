<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInstanceStore } from '@/stores/instance'
import { usePublicInstance } from '@/composables/usePublicInstance'
import { renderMarkdown } from '@/utils/markdown'

const { t } = useI18n()
const instanceStore = useInstanceStore()
const { data: ssrInstance } = await usePublicInstance()

const instance = computed(() => ssrInstance.value ?? instanceStore.instance)

const html = computed(() => {
  const md = instance.value?.terms_of_service
  return md ? renderMarkdown(md) : ''
})
</script>

<template>
  <div class="min-h-screen bg-gray-50 dark:bg-gray-900">
    <div class="max-w-3xl mx-auto px-4 py-12">
      <h1 class="text-3xl font-bold text-gray-900 dark:text-white mb-8">{{ t('legal.terms_of_service') }}</h1>
      <div v-if="html" class="prose dark:prose-invert max-w-none" v-html="html" />
      <p v-else class="text-gray-500 dark:text-gray-400">{{ t('legal.no_content') }}</p>
      <div class="mt-8">
        <router-link to="/" class="text-indigo-600 dark:text-indigo-400 hover:underline">&larr; {{ t('common.back') }}</router-link>
      </div>
    </div>
  </div>
</template>
