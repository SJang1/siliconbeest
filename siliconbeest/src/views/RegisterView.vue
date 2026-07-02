<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useInstanceStore } from '@/stores/instance'
import RegisterForm from '@/components/auth/RegisterForm.vue'

const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()
const instanceStore = useInstanceStore()

const error = ref<string | null>(null)

const registrationMode = computed(() => {
  if (!instanceStore.instance?.registrations.enabled) return 'closed'
  return instanceStore.instance?.registrations.approval_required ? 'approval' : 'open'
})

const registrationMessage = computed(() => {
  return instanceStore.instance?.registrations.message || ''
})

const instanceTitle = computed(() => {
  return instanceStore.instance?.title
})

onMounted(async () => {
  if (!instanceStore.instance) {
    await instanceStore.fetchInstance()
  }
})

async function handleRegister(data: {
  username: string
  email: string
  password: string
  locale: string
  reason?: string
  turnstile_token?: string
  agreement?: boolean
}) {
  error.value = null
  try {
    const result = await auth.register({
      username: data.username,
      email: data.email,
      password: data.password,
      agreement: true,
      locale: data.locale,
      reason: data.reason,
      turnstile_token: data.turnstile_token,
    })
    if (result.confirmationRequired) {
      router.push({ path: '/auth/confirm-email-sent', query: { email: data.email } })
    } else {
      router.push('/home')
    }
  } catch (e) {
    error.value = (e as Error).message
  }
}
</script>

<template>
  <div class="sb-app relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-12">
    <div class="sb-aurora" aria-hidden="true"></div>
    <div class="relative z-10 w-full max-w-md animate-rise-in">
      <div class="mb-8 text-center">
        <h1 class="sb-heading sb-gradient-text text-4xl">{{ instanceTitle }}</h1>
        <p class="mt-3 text-sm text-slate-500 dark:text-slate-400">{{ t('auth.join_us') }}</p>
      </div>
      <div class="sb-card p-8">
        <div v-if="error" class="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400">
          {{ error }}
        </div>
        <RegisterForm
          :registration-open="registrationMode !== 'closed'"
          :registration-mode="registrationMode"
          :registration-message="registrationMessage"
          @submit="handleRegister"
        />
      </div>
    </div>
  </div>
</template>
