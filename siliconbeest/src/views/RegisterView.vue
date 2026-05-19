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
  <div class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
    <div class="w-full max-w-sm">
      <div class="text-center mb-8">
        <h1 class="text-3xl font-bold text-indigo-600 dark:text-indigo-400">{{ instanceTitle }}</h1>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">{{ t('auth.join_us') }}</p>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
        <div v-if="error" class="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
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
