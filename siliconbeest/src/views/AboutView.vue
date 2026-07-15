<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useInstanceStore } from '@/stores/instance'
import { usePublicInstance } from '@/composables/usePublicInstance'
import AppShell from '@/components/layout/AppShell.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { withCurrentDesign } from '@/utils/safeRedirect'

const { t } = useI18n()
const route = useRoute()
const instanceStore = useInstanceStore()
const { data: ssrInstance, pending } = await usePublicInstance()

const instance = computed(() => ssrInstance.value ?? instanceStore.instance)
const loading = computed(() => pending.value || instanceStore.loading)
const registrationDescription = computed(() => {
  const registrations = instance.value?.registrations
  if (!registrations) return t('about.registration_closed')
  if (registrations.mode === 'referral') return t('about.registration_referral')
  if (registrations.mode === 'closed') return t('about.registration_closed')
  if (registrations.mode === 'approval') return t('about.registration_approval')
  if (registrations.mode === 'open') return t('about.registration_open')
  if (!registrations.enabled) return t('about.registration_closed')
  return registrations.approval_required
    ? t('about.registration_approval')
    : t('about.registration_open')
})
</script>

<template>
  <AppShell>
    <div>
      <header class="sb-glass sticky top-0 z-10 border-b px-4 py-3">
        <h1 class="sb-heading text-lg">{{ t('about.title') }}</h1>
      </header>

      <LoadingSpinner v-if="loading" />

      <div v-else class="mx-auto w-full max-w-3xl space-y-5 px-4 py-8 animate-fade-in">
        <div class="text-center">
          <h2 class="sb-heading text-3xl">
            <span class="sb-gradient-text">{{ instance?.title }}</span>
          </h2>
          <p class="mt-2 text-sm text-slate-500 dark:text-slate-400">{{ t('about.description') }}</p>
        </div>

        <div v-if="instance" class="space-y-5">
          <!-- Stats -->
          <div class="sb-card p-6">
            <h3 class="sb-heading mb-4 text-base">{{ t('about.stats') }}</h3>
            <dl class="grid grid-cols-3 gap-4 text-center">
              <div>
                <dt class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{{ t('about.users') }}</dt>
                <dd class="sb-heading mt-1 text-xl">{{ instance.usage?.users?.active_month ?? 0 }}</dd>
              </div>
              <div>
                <dt class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{{ t('about.version') }}</dt>
                <dd class="sb-heading mt-1 text-xl">{{ instance.version }}</dd>
              </div>
              <div>
                <dt class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{{ t('about.languages') }}</dt>
                <dd class="sb-heading mt-1 text-xl">{{ instance.languages?.length ?? 0 }}</dd>
              </div>
            </dl>
          </div>

          <!-- Description -->
          <div
            v-if="instance.description"
            class="sb-card prose prose-sm max-w-none p-6 dark:prose-invert"
            v-html="instance.description"
          />

          <!-- Rules -->
          <div v-if="instance.rules?.length" class="sb-card p-6">
            <h3 class="sb-heading mb-4 text-base">{{ t('about.rules') }}</h3>
            <ol class="space-y-3">
              <li
                v-for="(rule, index) in instance.rules"
                :key="rule.id"
                class="flex gap-3 text-sm"
              >
                <span class="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-bold text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
                  {{ index + 1 }}
                </span>
                <span class="whitespace-pre-line text-slate-700 dark:text-slate-300">{{ rule.text }}</span>
              </li>
            </ol>
          </div>

          <!-- Registration -->
          <div class="sb-card p-6">
            <h3 class="sb-heading mb-2 text-base">{{ t('about.registration') }}</h3>
            <p class="text-sm text-slate-600 dark:text-slate-400">
              {{ registrationDescription }}
            </p>
            <router-link
              :to="withCurrentDesign('/about/invitations', route.path)"
              class="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-brand-600 hover:underline dark:text-brand-400"
            >
              {{ t('about.invitation_guide_link') }}
              <span aria-hidden="true">→</span>
            </router-link>
          </div>

          <!-- Contact -->
          <div class="sb-card p-6">
            <h3 class="sb-heading mb-3 text-base">{{ t('about.contact') }}</h3>
            <div v-if="instance.contact?.account" class="flex items-center gap-3">
              <span class="sb-avatar-ring inline-flex flex-shrink-0">
                <img
                  :src="instance.contact.account.avatar"
                  :alt="instance.contact.account.display_name"
                  class="h-10 w-10 rounded-full"
                />
              </span>
              <div>
                <router-link
                  :to="`/@${instance.contact.account.acct}`"
                  class="text-sm font-semibold transition-colors hover:text-brand-600 hover:underline dark:hover:text-brand-400"
                >
                  {{ instance.contact.account.display_name }}
                </router-link>
                <p class="text-xs text-slate-500 dark:text-slate-400">
                  @{{ instance.contact.account.acct }}
                </p>
              </div>
            </div>
            <p v-if="instance.contact?.email" class="mt-2 text-sm text-slate-600 dark:text-slate-400">
              {{ instance.contact.email }}
            </p>
            <p v-if="!instance.contact?.account && !instance.contact?.email" class="text-sm text-slate-600 dark:text-slate-400">
              {{ t('about.no_contact') }}
            </p>
          </div>
        </div>

        <div v-else class="sb-empty">
          {{ t('about.unavailable') }}
        </div>
      </div>
    </div>
  </AppShell>
</template>
