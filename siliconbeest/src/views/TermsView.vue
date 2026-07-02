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
  <div class="sb-app min-h-dvh">
    <div class="mx-auto w-full max-w-3xl px-4 py-12 sm:py-16 animate-fade-in">
      <h1 class="sb-heading mb-8 text-3xl sm:text-4xl">{{ t('legal.terms_of_service') }}</h1>
      <div class="sb-card p-6 sm:p-8">
        <div v-if="html" class="prose max-w-none dark:prose-invert" v-html="html" />
        <p v-else class="text-sm text-slate-500 dark:text-slate-400">{{ t('legal.no_content') }}</p>
      </div>
      <div class="mt-8">
        <router-link to="/" class="sb-btn sb-btn-secondary">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="h-4 w-4" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
          </svg>
          {{ t('common.back') }}
        </router-link>
      </div>
    </div>
  </div>
</template>
