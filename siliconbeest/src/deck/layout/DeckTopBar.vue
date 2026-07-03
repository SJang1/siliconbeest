<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '@/stores/ui'
import { useAuthStore } from '@/stores/auth'
import { useInstanceStore } from '@/stores/instance'

const { t } = useI18n()
const ui = useUiStore()
const auth = useAuthStore()
const instanceStore = useInstanceStore()

// Instance branding only — same-origin URLs the worker always serves
// (/thumbnail.png falls back to a generated SVG server-side). Never a
// bundled placeholder. Last resort: the instance title's initial letter.
const LOGO_CANDIDATES = ['/thumbnail.png', '/favicon.ico']
const logoIndex = ref(0)
const logoSrc = computed(() => LOGO_CANDIDATES[logoIndex.value] ?? null)

function onLogoError() {
  logoIndex.value += 1
}

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
        <img v-if="logoSrc" :src="logoSrc" alt="" class="h-7 w-7 object-contain" @error="onLogoError" />
        <span v-else class="text-[18px] font-extrabold" style="color: var(--dk-acc-ink, #ffffff)">
          {{ (instanceStore.instance?.title || 'S').slice(0, 1) }}
        </span>
      </span>
      <span class="truncate text-[17px] font-extrabold tracking-[-0.3px]">
        {{ instanceStore.instance?.title }}
      </span>
    </router-link>

    <div class="flex-1" />

    <button type="button" class="dk-pill-btn" :aria-label="t('settings.theme')" @click="toggleTheme">
      <span aria-hidden="true">{{ ui.isDark ? '☀' : '☾' }}</span>
      <span class="hidden sm:inline">{{ ui.isDark ? t('settings.themeLight') : t('settings.themeDark') }}</span>
    </button>

    <!-- Compose: compact pen icon on mobile, "+ Note" pill on wider screens -->
    <button
      v-if="auth.isAuthenticated"
      type="button"
      class="dk-btn-accent h-9 w-9 !p-0 sm:h-auto sm:w-auto sm:!px-[17px] sm:!py-[9px]"
      :aria-label="t('deck.note')"
      @click="ui.openComposeModal()"
    >
      <svg class="h-[18px] w-[18px] sm:hidden" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
      </svg>
      <span class="hidden items-center gap-1.5 sm:inline-flex"><span aria-hidden="true">＋</span>{{ t('deck.note') }}</span>
    </button>
    <router-link v-else to="/login" class="dk-btn-accent no-underline">
      {{ t('auth.login') }}
    </router-link>
  </header>
</template>
