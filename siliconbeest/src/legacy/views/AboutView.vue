<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useInstanceStore } from '@/stores/instance'
import { usePublicInstance } from '@/composables/usePublicInstance'
import AppShell from '@/legacy/components/layout/AppShell.vue'
import LoadingSpinner from '@/legacy/components/common/LoadingSpinner.vue'
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
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <h1 class="text-xl font-bold">{{ t('about.title') }}</h1>
      </header>

      <LoadingSpinner v-if="loading" />

      <div v-else class="p-6 space-y-6">
        <div class="text-center">
          <h2 class="text-2xl font-bold text-indigo-600 dark:text-indigo-400">
            {{ instance?.title }}
          </h2>
          <p class="text-gray-500 dark:text-gray-400 mt-1">{{ t('about.description') }}</p>
        </div>

        <div v-if="instance" class="space-y-4">
          <!-- Stats -->
          <div class="rounded-xl bg-gray-50 dark:bg-gray-800 p-4">
            <h3 class="font-semibold mb-2">{{ t('about.stats') }}</h3>
            <dl class="grid grid-cols-3 gap-4 text-center">
              <div>
                <dt class="text-xs text-gray-500 dark:text-gray-400">{{ t('about.users') }}</dt>
                <dd class="text-lg font-bold">{{ instance.usage?.users?.active_month ?? 0 }}</dd>
              </div>
              <div>
                <dt class="text-xs text-gray-500 dark:text-gray-400">{{ t('about.version') }}</dt>
                <dd class="text-lg font-bold">{{ instance.version }}</dd>
              </div>
              <div>
                <dt class="text-xs text-gray-500 dark:text-gray-400">{{ t('about.languages') }}</dt>
                <dd class="text-lg font-bold">{{ instance.languages?.length ?? 0 }}</dd>
              </div>
            </dl>
          </div>

          <!-- Description -->
          <div
            v-if="instance.description"
            class="prose prose-sm dark:prose-invert max-w-none"
            v-html="instance.description"
          />

          <!-- Rules -->
          <div v-if="instance.rules?.length" class="rounded-xl bg-gray-50 dark:bg-gray-800 p-4">
            <h3 class="font-semibold mb-3">{{ t('about.rules') }}</h3>
            <ol class="space-y-2">
              <li
                v-for="(rule, index) in instance.rules"
                :key="rule.id"
                class="flex gap-3 text-sm"
              >
                <span class="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center text-xs font-bold">
                  {{ index + 1 }}
                </span>
                <span class="whitespace-pre-line">{{ rule.text }}</span>
              </li>
            </ol>
          </div>

          <!-- Registration -->
          <div class="rounded-xl bg-gray-50 dark:bg-gray-800 p-4">
            <h3 class="font-semibold mb-2">{{ t('about.registration') }}</h3>
            <p class="text-sm text-gray-600 dark:text-gray-400">
              {{ registrationDescription }}
            </p>
            <router-link
              :to="withCurrentDesign('/about/invitations', route.path)"
              class="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
            >
              {{ t('about.invitation_guide_link') }}
              <span aria-hidden="true">→</span>
            </router-link>
          </div>

          <!-- Contact -->
          <div class="rounded-xl bg-gray-50 dark:bg-gray-800 p-4">
            <h3 class="font-semibold mb-2">{{ t('about.contact') }}</h3>
            <div v-if="instance.contact?.account" class="flex items-center gap-3">
              <img
                :src="instance.contact.account.avatar"
                :alt="instance.contact.account.display_name"
                class="w-10 h-10 rounded-full"
              />
              <div>
                <router-link
                  :to="`/@${instance.contact.account.acct}`"
                  class="font-semibold text-sm hover:underline"
                >
                  {{ instance.contact.account.display_name }}
                </router-link>
                <p class="text-xs text-gray-500 dark:text-gray-400">
                  @{{ instance.contact.account.acct }}
                </p>
              </div>
            </div>
            <p v-if="instance.contact?.email" class="text-sm text-gray-600 dark:text-gray-400 mt-2">
              {{ instance.contact.email }}
            </p>
            <p v-if="!instance.contact?.account && !instance.contact?.email" class="text-sm text-gray-600 dark:text-gray-400">
              {{ t('about.no_contact') }}
            </p>
          </div>
        </div>

        <div v-else class="text-center text-gray-500 dark:text-gray-400">
          {{ t('about.unavailable') }}
        </div>
      </div>
    </div>
  </AppShell>
</template>
