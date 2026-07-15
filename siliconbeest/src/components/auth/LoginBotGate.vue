<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useTurnstile } from '@/composables/useTurnstile'

const props = withDefaults(
  defineProps<{
    siteKey: string
    returnTo: string
    legacy?: boolean
  }>(),
  { legacy: false },
)

const { t } = useI18n()
const route = useRoute()
const formRef = ref<HTMLFormElement | null>(null)
const turnstileToken = ref('')
const submitting = ref(false)
const verificationFailed = computed(
  () => route.query.turnstile_error === 'failed',
)

function handleVerified(token: string) {
  if (submitting.value) return

  submitting.value = true
  turnstileToken.value = token
  void nextTick(() => {
    formRef.value?.submit()
  })
}

const { render, remove } = useTurnstile({
  siteKey: props.siteKey,
  onVerified: handleVerified,
})

onMounted(() => {
  render('turnstile-login-preflight')
})

onBeforeUnmount(() => {
  remove()
})
</script>

<template>
  <form
    ref="formRef"
    method="post"
    action="/api/v1/auth/login/preflight"
    class="space-y-5 text-center"
    :aria-busy="submitting"
  >
    <input type="hidden" name="return_to" :value="returnTo" />
    <input type="hidden" name="turnstile_token" :value="turnstileToken" />

    <div>
      <h1 :class="legacy ? 'text-2xl font-bold' : 'sb-heading text-2xl'">
        {{ t('login_preflight.title') }}
      </h1>
      <p
        :class="[
          'mt-2 text-sm',
          legacy
            ? 'text-gray-500 dark:text-gray-400'
            : 'text-slate-500 dark:text-slate-400',
        ]"
      >
        {{ t('login_preflight.description') }}
      </p>
    </div>

    <div
      v-if="verificationFailed"
      role="alert"
      :class="[
        'p-3 text-sm text-red-600 dark:text-red-400',
        legacy
          ? 'rounded-lg bg-red-50 dark:bg-red-900/20'
          : 'rounded-xl border border-red-200 bg-red-50 dark:border-red-500/30 dark:bg-red-500/10',
      ]"
    >
      {{ t('turnstile.verification_failed') }}
    </div>

    <div id="turnstile-login-preflight" class="flex min-h-[65px] justify-center"></div>

    <p
      v-if="submitting"
      role="status"
      :class="legacy ? 'text-sm text-gray-500 dark:text-gray-400' : 'text-sm text-slate-500 dark:text-slate-400'"
    >
      {{ t('login_preflight.loading') }}
    </p>
  </form>
</template>
