<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps<{
  accountId: string
  following?: boolean
  requested?: boolean
  blocked?: boolean
}>()

const emit = defineEmits<{
  toggle: [accountId: string]
}>()

const loading = ref(false)

async function toggle() {
  loading.value = true
  emit('toggle', props.accountId)
  // Parent should handle the actual API call and update props
  loading.value = false
}

function label(): string {
  if (props.blocked) return t('profile.blocked')
  if (props.requested) return t('profile.requested')
  if (props.following) return t('profile.unfollow')
  return t('profile.follow')
}

function buttonClasses(): string {
  if (props.blocked) return 'bg-red-600 hover:bg-red-700 text-white'
  if (props.following || props.requested)
    return 'border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:border-red-500 hover:text-red-500'
  return 'bg-indigo-600 hover:bg-indigo-700 text-white'
}
</script>

<template>
  <button
    @click="toggle"
    :disabled="loading || blocked"
    class="px-4 py-1.5 rounded-full text-sm font-bold transition-colors disabled:opacity-50"
    :class="buttonClasses()"
    :aria-label="label()"
  >
    <span v-if="loading" class="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
    <span v-else>{{ label() }}</span>
  </button>
</template>
