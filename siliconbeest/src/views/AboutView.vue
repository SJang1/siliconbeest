<script setup lang="ts">
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInstanceStore } from '@/stores/instance'
import AppShell from '@/components/layout/AppShell.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()
const instanceStore = useInstanceStore()

onMounted(async () => {
  if (!instanceStore.instance) {
    await instanceStore.fetchInstance()
  }
})
</script>

<template>
  <AppShell>
    <div>
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <h1 class="text-xl font-bold">{{ t('about.title') }}</h1>
      </header>

      <LoadingSpinner v-if="instanceStore.loading" />

      <div v-else class="p-6 space-y-6">
        <div class="text-center">
          <h2 class="text-2xl font-bold text-indigo-600 dark:text-indigo-400">
            {{ instanceStore.instance?.title ?? 'SiliconBeest' }}
          </h2>
          <p class="text-gray-500 dark:text-gray-400 mt-1">{{ t('about.description') }}</p>
        </div>

        <div v-if="instanceStore.instance" class="space-y-4">
          <!-- Stats -->
          <div class="rounded-xl bg-gray-50 dark:bg-gray-800 p-4">
            <h3 class="font-semibold mb-2">{{ t('about.stats') }}</h3>
            <dl class="grid grid-cols-3 gap-4 text-center">
              <div>
                <dt class="text-xs text-gray-500 dark:text-gray-400">{{ t('about.users') }}</dt>
                <dd class="text-lg font-bold">{{ instanceStore.instance.usage?.users?.active_month ?? 0 }}</dd>
              </div>
              <div>
                <dt class="text-xs text-gray-500 dark:text-gray-400">{{ t('about.version') }}</dt>
                <dd class="text-lg font-bold">{{ instanceStore.instance.version }}</dd>
              </div>
              <div>
                <dt class="text-xs text-gray-500 dark:text-gray-400">{{ t('about.languages') }}</dt>
                <dd class="text-lg font-bold">{{ instanceStore.instance.languages?.length ?? 0 }}</dd>
              </div>
            </dl>
          </div>

          <!-- Description -->
          <div
            v-if="instanceStore.instance.description"
            class="prose prose-sm dark:prose-invert max-w-none"
            v-html="instanceStore.instance.description"
          />

          <!-- Rules -->
          <div v-if="instanceStore.instance.rules?.length" class="rounded-xl bg-gray-50 dark:bg-gray-800 p-4">
            <h3 class="font-semibold mb-3">{{ t('about.rules') }}</h3>
            <ol class="space-y-2">
              <li
                v-for="(rule, index) in instanceStore.instance.rules"
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
              {{ instanceStore.instance.registrations?.enabled
                ? (instanceStore.instance.registrations.approval_required
                  ? t('about.registration_approval')
                  : t('about.registration_open'))
                : t('about.registration_closed')
              }}
            </p>
          </div>

          <!-- Contact -->
          <div class="rounded-xl bg-gray-50 dark:bg-gray-800 p-4">
            <h3 class="font-semibold mb-2">{{ t('about.contact') }}</h3>
            <div v-if="instanceStore.instance.contact?.account" class="flex items-center gap-3">
              <img
                :src="instanceStore.instance.contact.account.avatar"
                :alt="instanceStore.instance.contact.account.display_name"
                class="w-10 h-10 rounded-full"
              />
              <div>
                <router-link
                  :to="`/@${instanceStore.instance.contact.account.acct}`"
                  class="font-semibold text-sm hover:underline"
                >
                  {{ instanceStore.instance.contact.account.display_name }}
                </router-link>
                <p class="text-xs text-gray-500 dark:text-gray-400">
                  @{{ instanceStore.instance.contact.account.acct }}
                </p>
              </div>
            </div>
            <p v-if="instanceStore.instance.contact?.email" class="text-sm text-gray-600 dark:text-gray-400 mt-2">
              {{ instanceStore.instance.contact.email }}
            </p>
            <p v-if="!instanceStore.instance.contact?.account && !instanceStore.instance.contact?.email" class="text-sm text-gray-600 dark:text-gray-400">
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
