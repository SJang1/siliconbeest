<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInstanceStore } from '@/stores/instance'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import DeckAdminLayout from '@/deck/layout/DeckAdminLayout.vue'

const { t } = useI18n()
const instanceStore = useInstanceStore()

const loading = ref(false)
const error = ref<string | null>(null)

onMounted(async () => {
  if (!instanceStore.instance) {
    loading.value = true
    try {
      await instanceStore.fetchInstance()
    } catch (e) {
      error.value = (e as Error).message
    } finally {
      loading.value = false
    }
  }
})

const stats = computed(() => {
  const inst = instanceStore.instance
  if (!inst) return []
  return [
    {
      label: t('admin.statTotalUsers'),
      value: inst.usage?.users?.active_month ?? 0,
      icon: 'users',
      color: 'indigo',
    },
    {
      label: t('admin.statActiveUsers'),
      value: inst.usage?.users?.active_month ?? 0,
      icon: 'activity',
      color: 'green',
    },
    {
      label: t('admin.statVersion'),
      value: inst.version,
      icon: 'info',
      color: 'blue',
    },
    {
      label: t('admin.statDomain'),
      value: inst.domain,
      icon: 'globe',
      color: 'purple',
    },
  ]
})

const registrationModeLabel = computed(() => {
  const registrations = instanceStore.instance?.registrations
  if (!registrations) return ''
  if (registrations.mode === 'referral') return t('admin.registrationMode.referral')
  if (registrations.mode === 'closed') return t('admin.registrationMode.closed')
  if (registrations.mode === 'approval') return t('admin.registrationMode.approval')
  if (registrations.mode === 'open') return t('admin.registrationMode.open')
  if (!registrations.enabled) return t('admin.registrationMode.closed')
  return registrations.approval_required
    ? t('admin.registrationMode.approval')
    : t('admin.registrationMode.open')
})

// Presentation only: heroicons (24 outline) paths for the stat tile icon chips
const iconPaths: Record<string, string> = {
  users:
    'M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z',
  activity: 'M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z',
  info: 'M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z',
  globe:
    'M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418',
}
</script>

<template>
  <DeckAdminLayout>
  <div class="w-full max-w-5xl animate-fade-in">
    <h1 class="sb-heading mb-6 text-2xl text-slate-900 dark:text-white">{{ t('admin.dashboard') }}</h1>

    <LoadingSpinner v-if="loading" />

    <div v-else-if="error" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
      {{ error }}
    </div>

    <div v-else class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div
        v-for="stat in stats"
        :key="stat.label"
        class="sb-card sb-card-hover p-5"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <p class="text-sm font-medium text-slate-500 dark:text-slate-400">{{ stat.label }}</p>
            <p class="sb-heading mt-1.5 truncate text-2xl text-slate-900 dark:text-white">{{ stat.value }}</p>
          </div>
          <span
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-400"
            aria-hidden="true"
          >
            <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" :d="iconPaths[stat.icon]" />
            </svg>
          </span>
        </div>
      </div>
    </div>

    <!-- Instance info -->
    <div v-if="instanceStore.instance" class="sb-card mt-8 p-6">
      <h2 class="sb-heading mb-4 text-lg text-slate-900 dark:text-white">{{ t('admin.instanceInfo') }}</h2>
      <dl class="divide-y divide-outline dark:divide-outline-dark">
        <div class="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
          <dt class="text-sm text-slate-500 dark:text-slate-400">{{ t('admin.instanceTitle') }}</dt>
          <dd class="text-sm font-medium text-slate-900 dark:text-white">{{ instanceStore.instance.title }}</dd>
        </div>
        <div class="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
          <dt class="text-sm text-slate-500 dark:text-slate-400">{{ t('admin.instanceDomain') }}</dt>
          <dd class="text-sm font-medium text-slate-900 dark:text-white">{{ instanceStore.instance.domain }}</dd>
        </div>
        <div class="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
          <dt class="text-sm text-slate-500 dark:text-slate-400">{{ t('admin.instanceVersion') }}</dt>
          <dd class="text-sm font-medium text-slate-900 dark:text-white">{{ instanceStore.instance.version }}</dd>
        </div>
        <div class="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
          <dt class="text-sm text-slate-500 dark:text-slate-400">{{ t('admin.registrations') }}</dt>
          <dd class="text-sm font-medium text-slate-900 dark:text-white">
            {{ registrationModeLabel }}
          </dd>
        </div>
      </dl>
    </div>
  </div>
  </DeckAdminLayout>
</template>
