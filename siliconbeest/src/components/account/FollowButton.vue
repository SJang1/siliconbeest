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
const hovering = ref(false)

async function toggle() {
  loading.value = true
  emit('toggle', props.accountId)
  loading.value = false
}

function label(): string {
  if (props.blocked) return t('profile.blocked')
  if (props.requested) return hovering.value ? t('profile.cancel_request') : t('profile.requested')
  if (props.following) return hovering.value ? t('profile.unfollow') : t('profile.following')
  return t('profile.follow')
}

function buttonClasses(): string {
  if (props.blocked) return 'sb-btn-danger'
  if (props.requested)
    return 'border border-amber-300 bg-amber-50 text-amber-700 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 active:scale-[0.98] dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/10 dark:hover:text-rose-400'
  if (props.following)
    return 'sb-btn-secondary hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/10 dark:hover:text-rose-400'
  return 'sb-btn-primary'
}
</script>

<template>
  <button
    @click="toggle"
    :disabled="loading || blocked"
    @mouseenter="hovering = true"
    @mouseleave="hovering = false"
    class="sb-btn min-w-24"
    :class="buttonClasses()"
    :aria-label="label()"
  >
    <span v-if="loading" class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
    <span v-else>{{ label() }}</span>
  </button>
</template>
