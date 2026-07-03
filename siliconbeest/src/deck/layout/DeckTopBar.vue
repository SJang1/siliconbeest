<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '@/stores/ui'
import { useAuthStore } from '@/stores/auth'
import { useInstanceStore } from '@/stores/instance'
import { useTimelinesStore } from '@/stores/timelines'
import logoUrl from '@/assets/logo.svg'

const { t } = useI18n()
const ui = useUiStore()
const auth = useAuthStore()
const instanceStore = useInstanceStore()
const timelinesStore = useTimelinesStore()

const logoFailed = ref(false)
const logoSrc = computed(() =>
  logoFailed.value ? logoUrl : instanceStore.instance?.thumbnail?.url || logoUrl,
)
const streaming = computed(() => timelinesStore.streamingClients.size > 0)

function toggleTheme() {
  ui.setTheme(ui.isDark ? 'light' : 'dark')
}
</script>

<template>
  <header class="dk-hairline-b flex flex-none items-center gap-3 px-4 py-2.5 sm:px-[18px]">
    <router-link to="/" class="dk-text flex min-w-0 items-center gap-3.5 no-underline">
      <span
        class="grid h-[38px] w-[38px] flex-none place-items-center overflow-hidden rounded-xl"
        style="background: var(--dk-acc)"
      >
        <img :src="logoSrc" alt="" class="h-7 w-7 object-contain" @error="logoFailed = true" />
      </span>
      <span class="truncate text-[17px] font-extrabold tracking-[-0.3px]">
        {{ instanceStore.instance?.title }}
      </span>
    </router-link>

    <div class="flex-1" />

    <div v-if="streaming" class="dk-pill-btn dk-dim-text hidden cursor-default sm:inline-flex">
      <span class="dk-dot" aria-hidden="true" />
      <span>{{ t('deck.streaming') }}</span>
    </div>

    <button type="button" class="dk-pill-btn" :aria-label="t('settings.theme')" @click="toggleTheme">
      <span aria-hidden="true">{{ ui.isDark ? '☀' : '☾' }}</span>
      <span class="hidden sm:inline">{{ ui.isDark ? t('settings.themeLight') : t('settings.themeDark') }}</span>
    </button>

    <button
      v-if="auth.isAuthenticated"
      type="button"
      class="dk-btn-accent"
      @click="ui.openComposeModal()"
    >
      <span aria-hidden="true">＋</span>{{ t('deck.note') }}
    </button>
    <router-link v-else to="/login" class="dk-btn-accent no-underline">
      {{ t('auth.login') }}
    </router-link>
  </header>
</template>
