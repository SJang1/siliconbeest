<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInstanceStore } from '@/stores/instance'

const { t } = useI18n()
const instanceStore = useInstanceStore()
const instance = ref<any>(null)

onMounted(async () => {
  await instanceStore.fetchInstance()
  instance.value = instanceStore.instance
})
</script>

<template>
  <div class="min-h-screen bg-gray-50 dark:bg-gray-900">
    <!-- Hero -->
    <div class="max-w-4xl mx-auto px-4 pt-20 pb-16 text-center">
      <h1 class="text-5xl font-bold text-indigo-600 dark:text-indigo-400 mb-4">
        {{ instance?.title || 'SiliconBeest' }}
      </h1>
      <p class="text-xl text-gray-600 dark:text-gray-300 mb-8 max-w-2xl mx-auto">
        {{ instance?.description || t('landing.tagline') }}
      </p>
      <div class="flex gap-4 justify-center">
        <router-link
          to="/register"
          class="px-8 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-full text-lg transition-colors no-underline"
        >
          {{ t('auth.sign_up') }}
        </router-link>
        <router-link
          to="/login"
          class="px-8 py-3 border-2 border-indigo-600 dark:border-indigo-400 text-indigo-600 dark:text-indigo-400 font-bold rounded-full text-lg hover:bg-indigo-50 dark:hover:bg-gray-800 transition-colors no-underline"
        >
          {{ t('auth.sign_in') }}
        </router-link>
      </div>
    </div>

    <!-- Features -->
    <div class="max-w-4xl mx-auto px-4 pb-20">
      <div class="grid md:grid-cols-3 gap-8">
        <div class="text-center p-6">
          <div class="text-4xl mb-3">🌐</div>
          <h3 class="font-bold text-lg mb-2 text-gray-900 dark:text-gray-100">{{ t('landing.feature_federated') }}</h3>
          <p class="text-gray-600 dark:text-gray-400 text-sm">{{ t('landing.feature_federated_desc') }}</p>
        </div>
        <div class="text-center p-6">
          <div class="text-4xl mb-3">🔒</div>
          <h3 class="font-bold text-lg mb-2 text-gray-900 dark:text-gray-100">{{ t('landing.feature_privacy') }}</h3>
          <p class="text-gray-600 dark:text-gray-400 text-sm">{{ t('landing.feature_privacy_desc') }}</p>
        </div>
        <div class="text-center p-6">
          <div class="text-4xl mb-3">💬</div>
          <h3 class="font-bold text-lg mb-2 text-gray-900 dark:text-gray-100">{{ t('landing.feature_community') }}</h3>
          <p class="text-gray-600 dark:text-gray-400 text-sm">{{ t('landing.feature_community_desc') }}</p>
        </div>
      </div>
    </div>

    <!-- Instance stats -->
    <div v-if="instance" class="max-w-4xl mx-auto px-4 pb-16 text-center text-gray-500 dark:text-gray-400 text-sm">
      <span>{{ t('landing.users', { count: instance.usage?.users?.active_month ?? 0 }) }}</span>
      <span class="mx-3">·</span>
      <span>{{ t('landing.powered_by') }}</span>
    </div>

    <!-- Footer -->
    <footer class="border-t border-gray-200 dark:border-gray-700 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
      <router-link to="/about" class="hover:underline">{{ t('nav.about') }}</router-link>
      <span class="mx-2">·</span>
      <router-link to="/explore" class="hover:underline">{{ t('nav.explore') }}</router-link>
    </footer>
  </div>
</template>
