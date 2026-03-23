<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import Avatar from '../common/Avatar.vue'

const { t } = useI18n()
const router = useRouter()

const navItems = [
  { key: 'home', path: '/', icon: '🏠' },
  { key: 'explore', path: '/explore', icon: '🔍' },
  { key: 'notifications', path: '/notifications', icon: '🔔' },
  { key: 'search', path: '/search', icon: '🔎' },
  { key: 'bookmarks', path: '/bookmarks', icon: '🔖' },
  { key: 'favourites', path: '/favourites', icon: '⭐' },
  { key: 'settings', path: '/settings', icon: '⚙️' },
]

function compose() {
  router.push({ name: 'compose' })
}
</script>

<template>
  <nav class="flex flex-col h-full p-4" aria-label="Main navigation">
    <!-- Logo -->
    <router-link to="/" class="flex items-center gap-2 px-3 py-2 mb-4">
      <span class="text-2xl font-bold text-indigo-600 dark:text-indigo-400">SiliconBeest</span>
    </router-link>

    <!-- Nav Links -->
    <ul class="space-y-1 flex-1">
      <li v-for="item in navItems" :key="item.key">
        <router-link
          :to="item.path"
          class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-lg font-medium transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
          active-class="bg-gray-100 dark:bg-gray-800 font-bold"
        >
          <span class="text-xl w-7 text-center" aria-hidden="true">{{ item.icon }}</span>
          <span>{{ t(`nav.${item.key}`) }}</span>
        </router-link>
      </li>
    </ul>

    <!-- Compose Button -->
    <button
      @click="compose"
      class="w-full py-3 px-4 mb-4 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-lg transition-colors"
      :aria-label="t('compose.title')"
    >
      {{ t('compose.title') }}
    </button>

    <!-- Current User -->
    <div class="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer">
      <Avatar src="" alt="User" size="sm" />
      <div class="flex-1 min-w-0">
        <p class="font-semibold text-sm truncate">{{ t('nav.profile') }}</p>
        <p class="text-xs text-gray-500 dark:text-gray-400 truncate">@user</p>
      </div>
    </div>
  </nav>
</template>
