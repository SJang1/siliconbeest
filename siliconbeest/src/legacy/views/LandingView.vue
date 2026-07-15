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
import AnnouncementBanner from '@/legacy/components/common/AnnouncementBanner.vue'
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
  <div class="min-h-screen bg-gray-50 dark:bg-gray-900">
    <!-- Announcements -->
    <AnnouncementBanner />

    <!-- Hero -->
    <div class="max-w-4xl mx-auto px-4 pt-20 pb-16 text-center">
      <h1 class="text-5xl font-bold text-indigo-600 dark:text-indigo-400 mb-4">
        {{ instance?.title }}
      </h1>
      <p class="text-xl text-gray-600 dark:text-gray-300 mb-8 max-w-2xl mx-auto">
        {{ instance?.description || t('landing.tagline') }}
      </p>
      <div
        v-if="invitationLoading || invitation || invitationError"
        class="mx-auto mb-8 w-full max-w-md rounded-xl border border-gray-200 bg-white p-4 text-left shadow-sm dark:border-gray-700 dark:bg-gray-800"
      >
        <p v-if="invitationLoading" class="text-center text-sm text-gray-500 dark:text-gray-400">
          {{ t('common.loading') }}
        </p>
        <div v-else-if="invitation" class="flex items-center gap-3">
          <img
            :src="invitation.inviter.avatar || '/default-avatar.svg'"
            :alt="invitation.inviter.display_name || invitation.inviter.username"
            class="h-12 w-12 rounded-full object-cover"
          />
          <div class="min-w-0">
            <p class="text-xs font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-400">
              {{ t('auth.registration_invited_by') }}
            </p>
            <p class="truncate font-semibold text-gray-900 dark:text-white">
              {{ invitation.inviter.display_name || invitation.inviter.username }}
            </p>
            <p class="truncate text-xs text-gray-500 dark:text-gray-400">
              @{{ invitation.inviter.username }}
            </p>
          </div>
        </div>
        <p v-else class="text-sm text-red-600 dark:text-red-400" role="alert">
          {{ invitationError }}
        </p>
      </div>
      <div class="flex gap-4 justify-center">
        <router-link
          :to="registrationTarget"
          class="px-8 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-full text-lg transition-colors no-underline"
        >
          {{ t('auth.sign_up') }}
        </router-link>
        <router-link
          :to="withCurrentDesign('/login', route.path)"
          class="px-8 py-3 border-2 border-indigo-600 dark:border-indigo-400 text-indigo-600 dark:text-indigo-400 font-bold rounded-full text-lg hover:bg-indigo-50 dark:hover:bg-gray-800 transition-colors no-underline"
        >
          {{ t('auth.sign_in') }}
        </router-link>
      </div>
    </div>

    <!-- Admin-customizable content (Markdown) -->
    <div v-if="landingHtml" class="max-w-3xl mx-auto px-4 pb-16">
      <div class="prose dark:prose-invert prose-indigo max-w-none bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-8" v-html="landingHtml" />
    </div>

    <!-- Instance stats -->
    <div v-if="instance" class="max-w-4xl mx-auto px-4 pb-16 text-center text-gray-500 dark:text-gray-400 text-sm">
      <span>{{ t('landing.users', { count: instance.usage?.users?.active_month ?? 0 }) }}</span>
      <span class="mx-3">&middot;</span>
      <span>{{ t('landing.powered_by') }}</span>
    </div>

    <!-- Footer -->
    <footer class="border-t border-gray-200 dark:border-gray-700 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
      <router-link to="/about" class="hover:underline">{{ t('nav.about') }}</router-link>
      <span class="mx-2">&middot;</span>
      <router-link to="/explore" class="hover:underline">{{ t('nav.explore') }}</router-link>
      <template v-if="instance?.terms_of_service">
        <span class="mx-2">&middot;</span>
        <router-link to="/terms" class="hover:underline">{{ t('legal.terms_of_service') }}</router-link>
      </template>
      <template v-if="instance?.privacy_policy">
        <span class="mx-2">&middot;</span>
        <router-link to="/privacy" class="hover:underline">{{ t('legal.privacy_policy') }}</router-link>
      </template>
    </footer>
  </div>
</template>
