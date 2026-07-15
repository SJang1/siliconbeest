<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useInstanceStore } from '@/stores/instance'
import { usePublicInstance } from '@/composables/usePublicInstance'
import { previewInvitation } from '@/api/mastodon/registration'
import { getApiErrorMessage } from '@/utils/apiError'
import { withCurrentDesign } from '@/utils/safeRedirect'
import { renderMarkdown } from '@/utils/markdown'
import AnnouncementBanner from '@/components/common/AnnouncementBanner.vue'
import type { InvitationPreview } from '@/types/registration'

const { t } = useI18n()
const route = useRoute()
const instanceStore = useInstanceStore()
const { data: ssrInstance } = await usePublicInstance()

const invitation = ref<InvitationPreview | null>(null)
const invitationLoading = ref(false)
const invitationError = ref('')

const instance = computed(() => ssrInstance.value ?? instanceStore.instance)
const invitationToken = computed(() => {
  const value = route.query.invite
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
})
const registrationTarget = computed(() => ({
  path: withCurrentDesign('/register', route.path),
  query: {
    invite: invitationToken.value || undefined,
    redirect: route.query.redirect,
  },
}))

const landingHtml = computed(() => {
  const md = instance.value?.site_landing_markdown
  return md ? renderMarkdown(md) : ''
})

async function loadInvitation() {
  invitation.value = null
  invitationError.value = ''
  if (!invitationToken.value) return

  invitationLoading.value = true
  try {
    const { data } = await previewInvitation(invitationToken.value)
    invitation.value = data
  } catch (requestError) {
    invitationError.value = getApiErrorMessage(
      requestError,
      t('auth.registration_invite_invalid'),
    )
  } finally {
    invitationLoading.value = false
  }
}

onMounted(loadInvitation)
watch(invitationToken, () => {
  if (typeof window !== 'undefined') void loadInvitation()
})
</script>

<template>
  <div class="sb-app min-h-dvh">
    <!-- Announcements -->
    <AnnouncementBanner />

    <!-- Hero + feature highlights above the aurora backdrop -->
    <div class="relative overflow-hidden">
      <div class="sb-aurora" aria-hidden="true"></div>

      <!-- Hero -->
      <section class="relative z-10 mx-auto flex min-h-dvh w-full max-w-5xl flex-col items-center justify-center px-4 py-24 text-center">
        <h1 class="sb-heading animate-rise-in text-5xl leading-[1.1] sm:text-6xl md:text-7xl">
          <span class="sb-gradient-text">{{ instance?.title }}</span>
        </h1>
        <p class="mt-6 max-w-2xl animate-rise-in text-lg text-slate-600 [animation-delay:100ms] sm:text-xl dark:text-slate-300">
          {{ instance?.description || t('landing.tagline') }}
        </p>
        <div
          v-if="invitationLoading || invitation || invitationError"
          class="sb-card mt-8 w-full max-w-md p-4 text-left animate-rise-in [animation-delay:150ms]"
        >
          <p v-if="invitationLoading" class="text-center text-sm text-slate-500 dark:text-slate-400">
            {{ t('common.loading') }}
          </p>
          <div v-else-if="invitation" class="flex items-center gap-3">
            <img
              :src="invitation.inviter.avatar || '/default-avatar.svg'"
              :alt="invitation.inviter.display_name || invitation.inviter.username"
              class="h-12 w-12 rounded-full object-cover"
            />
            <div class="min-w-0">
              <p class="text-xs font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-300">
                {{ t('auth.registration_invited_by') }}
              </p>
              <p class="truncate font-semibold text-slate-900 dark:text-white">
                {{ invitation.inviter.display_name || invitation.inviter.username }}
              </p>
              <p class="truncate text-xs text-slate-500 dark:text-slate-400">
                @{{ invitation.inviter.username }}
              </p>
            </div>
          </div>
          <p v-else class="text-sm text-red-600 dark:text-red-400" role="alert">
            {{ invitationError }}
          </p>
        </div>
        <div class="mt-10 flex flex-wrap items-center justify-center gap-4 animate-rise-in [animation-delay:200ms]">
          <router-link
            :to="registrationTarget"
            class="sb-btn sb-btn-primary px-8 py-3 text-base"
          >
            {{ t('auth.sign_up') }}
          </router-link>
          <router-link
            :to="withCurrentDesign('/login', route.path)"
            class="sb-btn sb-btn-secondary px-8 py-3 text-base"
          >
            {{ t('auth.sign_in') }}
          </router-link>
        </div>
      </section>

      <!-- Feature highlights -->
      <section class="relative z-10 mx-auto w-full max-w-5xl px-4 pb-24">
        <div class="grid gap-5 sm:grid-cols-3">
          <div class="sb-card sb-card-hover p-6 text-left">
            <div class="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-300">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="h-6 w-6" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
              </svg>
            </div>
            <h2 class="sb-heading mt-4 text-lg">{{ t('landing.feature_federated') }}</h2>
            <p class="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              {{ t('landing.feature_federated_desc') }}
            </p>
          </div>

          <div class="sb-card sb-card-hover p-6 text-left">
            <div class="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-300">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="h-6 w-6" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
              </svg>
            </div>
            <h2 class="sb-heading mt-4 text-lg">{{ t('landing.feature_privacy') }}</h2>
            <p class="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              {{ t('landing.feature_privacy_desc') }}
            </p>
          </div>

          <div class="sb-card sb-card-hover p-6 text-left">
            <div class="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-300">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="h-6 w-6" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
              </svg>
            </div>
            <h2 class="sb-heading mt-4 text-lg">{{ t('landing.feature_community') }}</h2>
            <p class="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              {{ t('landing.feature_community_desc') }}
            </p>
          </div>
        </div>
      </section>
    </div>

    <!-- Admin-customizable content (Markdown) -->
    <div v-if="landingHtml" class="mx-auto w-full max-w-3xl px-4 pb-16">
      <div class="sb-card prose prose-indigo max-w-none p-8 dark:prose-invert" v-html="landingHtml" />
    </div>

    <!-- Instance stats -->
    <div v-if="instance" class="mx-auto w-full max-w-4xl px-4 pb-16 text-center text-sm text-slate-500 dark:text-slate-400">
      <span>{{ t('landing.users', { count: instance.usage?.users?.active_month ?? 0 }) }}</span>
      <span class="mx-3">&middot;</span>
      <span>{{ t('landing.powered_by') }}</span>
    </div>

    <!-- Footer -->
    <footer class="border-t border-outline py-8 text-center text-sm text-slate-500 dark:border-outline-dark dark:text-slate-400">
      <router-link to="/about" class="transition-colors hover:text-brand-600 hover:underline dark:hover:text-brand-400">{{ t('nav.about') }}</router-link>
      <span class="mx-2">&middot;</span>
      <router-link to="/explore" class="transition-colors hover:text-brand-600 hover:underline dark:hover:text-brand-400">{{ t('nav.explore') }}</router-link>
      <template v-if="instance?.terms_of_service">
        <span class="mx-2">&middot;</span>
        <router-link to="/terms" class="transition-colors hover:text-brand-600 hover:underline dark:hover:text-brand-400">{{ t('legal.terms_of_service') }}</router-link>
      </template>
      <template v-if="instance?.privacy_policy">
        <span class="mx-2">&middot;</span>
        <router-link to="/privacy" class="transition-colors hover:text-brand-600 hover:underline dark:hover:text-brand-400">{{ t('legal.privacy_policy') }}</router-link>
      </template>
    </footer>
  </div>
</template>
