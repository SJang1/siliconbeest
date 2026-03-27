<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInstanceStore } from '@/stores/instance'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import AdminLayout from '@/components/layout/AdminLayout.vue'

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

const colorClasses: Record<string, string> = {
  indigo: 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800',
  green: 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 border-green-200 dark:border-green-800',
  blue: 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800',
  purple: 'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-800',
}
</script>

<template>
  <AdminLayout>
  <div class="w-full">
    <h1 class="text-2xl font-bold mb-6 text-gray-900 dark:text-white">{{ t('admin.dashboard') }}</h1>

    <LoadingSpinner v-if="loading" />

    <div v-else-if="error" class="p-4 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400">
      {{ error }}
    </div>

    <div v-else class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div
        v-for="stat in stats"
        :key="stat.label"
        class="p-5 rounded-xl border"
        :class="colorClasses[stat.color]"
      >
        <p class="text-sm font-medium opacity-80 mb-1">{{ stat.label }}</p>
        <p class="text-2xl font-bold">{{ stat.value }}</p>
      </div>
    </div>

    <!-- Instance info -->
    <div v-if="instanceStore.instance" class="mt-8 p-6 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      <h2 class="text-lg font-semibold text-gray-900 dark:text-white mb-4">{{ t('admin.instanceInfo') }}</h2>
      <dl class="space-y-3">
        <div class="flex justify-between">
          <dt class="text-sm text-gray-500 dark:text-gray-400">{{ t('admin.instanceTitle') }}</dt>
          <dd class="text-sm font-medium text-gray-900 dark:text-white">{{ instanceStore.instance.title }}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-sm text-gray-500 dark:text-gray-400">{{ t('admin.instanceDomain') }}</dt>
          <dd class="text-sm font-medium text-gray-900 dark:text-white">{{ instanceStore.instance.domain }}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-sm text-gray-500 dark:text-gray-400">{{ t('admin.instanceVersion') }}</dt>
          <dd class="text-sm font-medium text-gray-900 dark:text-white">{{ instanceStore.instance.version }}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-sm text-gray-500 dark:text-gray-400">{{ t('admin.registrations') }}</dt>
          <dd class="text-sm font-medium text-gray-900 dark:text-white">
            {{ instanceStore.instance.registrations.enabled ? t('admin.registrationMode.open') : t('admin.registrationMode.closed') }}
          </dd>
        </div>
      </dl>
    </div>
  </div>
  </AdminLayout>
</template>
