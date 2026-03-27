<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { apiFetch } from '@/api/client'

const { t } = useI18n()
const route = useRoute()

const email = computed(() => (route.query.email as string) || '')
const loading = ref(false)
const resent = ref(false)
const error = ref('')
const cooldown = ref(0)
let cooldownTimer: ReturnType<typeof setInterval> | null = null

function startCooldown() {
  cooldown.value = 60
  cooldownTimer = setInterval(() => {
    cooldown.value--
    if (cooldown.value <= 0 && cooldownTimer) {
      clearInterval(cooldownTimer)
      cooldownTimer = null
    }
  }, 1000)
}

async function handleResend() {
  if (cooldown.value > 0 || !email.value) return
  loading.value = true
  error.value = ''
  resent.value = false
  try {
    await apiFetch('/v1/auth/resend_confirmation', {
      method: 'POST',
      body: JSON.stringify({ email: email.value }),
    })
    resent.value = true
    startCooldown()
  } catch (e: any) {
    error.value = e?.error || t('common.error')
  } finally {
    loading.value = false
  }
}

onUnmounted(() => {
  if (cooldownTimer) clearInterval(cooldownTimer)
})
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
    <div class="w-full max-w-sm">
      <div class="text-center mb-8">
        <h1 class="text-3xl font-bold text-indigo-600 dark:text-indigo-400">SiliconBeest</h1>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
        <div class="text-center space-y-4">
          <!-- Mail icon -->
          <div class="text-5xl">
            <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-16 w-16 text-indigo-500 dark:text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
            </svg>
          </div>

          <!-- Title -->
          <h2 class="text-xl font-bold text-gray-900 dark:text-white">
            {{ t('auth.confirmation_required') }}
          </h2>

          <!-- Message -->
          <p class="text-sm text-gray-600 dark:text-gray-400">
            {{ t('auth.confirmation_sent', { email }) }}
          </p>

          <!-- Success message -->
          <div v-if="resent" class="p-3 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 text-sm">
            {{ t('auth.resend_success') }}
          </div>

          <!-- Error -->
          <div v-if="error" class="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm" role="alert">
            {{ error }}
          </div>

          <!-- Resend button -->
          <button
            @click="handleResend"
            :disabled="loading || cooldown > 0"
            class="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold transition-colors disabled:opacity-50"
          >
            <template v-if="loading">{{ t('common.loading') }}</template>
            <template v-else-if="cooldown > 0">{{ t('auth.resend_cooldown') }} ({{ cooldown }}s)</template>
            <template v-else>{{ t('auth.resend_confirmation') }}</template>
          </button>

          <!-- Back to login -->
          <p class="text-center text-sm text-gray-500 dark:text-gray-400">
            <router-link to="/login" class="text-indigo-600 dark:text-indigo-400 hover:underline font-medium">
              {{ t('auth.sign_in') }}
            </router-link>
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
