<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const tabs = [
  { key: 'home', path: '/', icon: '🏠' },
  { key: 'search', path: '/search', icon: '🔍' },
  { key: 'compose', path: '/compose', icon: '➕' },
  { key: 'notifications', path: '/notifications', icon: '🔔' },
  { key: 'profile', path: '/profile', icon: '👤' },
]
</script>

<template>
  <nav
    class="fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 z-50"
    aria-label="Mobile navigation"
  >
    <ul class="flex justify-around items-center h-14">
      <li v-for="tab in tabs" :key="tab.key">
        <router-link
          :to="tab.path"
          class="flex flex-col items-center justify-center w-14 h-14 text-gray-500 dark:text-gray-400 transition-colors"
          active-class="text-indigo-600 dark:text-indigo-400"
          :aria-label="t(`nav.${tab.key}`)"
        >
          <span class="text-xl" aria-hidden="true">{{ tab.icon }}</span>
        </router-link>
      </li>
    </ul>
  </nav>
</template>
