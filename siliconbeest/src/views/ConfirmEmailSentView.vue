<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { apiFetch } from '@/api/client'
import { useInstanceStore } from '@/stores/instance'
import { withCurrentDesign } from '@/utils/safeRedirect'

const { t } = useI18n()
const route = useRoute()
const instanceStore = useInstanceStore()

const email = computed(() => (route.query.email as string) || '')
const instanceTitle = computed(() => instanceStore.instance?.title)
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
  <div class="sb-app relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-12">
    <div class="sb-aurora" aria-hidden="true"></div>
    <div class="relative z-10 w-full max-w-md animate-rise-in">
      <div class="mb-8 text-center">
        <h1 class="sb-heading sb-gradient-text text-4xl">{{ instanceTitle }}</h1>
      </div>
      <div class="sb-card p-8">
        <div class="space-y-4 text-center">
          <!-- Mail icon -->
          <div class="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-400">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
            </svg>
          </div>

          <!-- Title -->
          <h2 class="sb-heading text-xl text-slate-900 dark:text-white">
            {{ t('auth.confirmation_required') }}
          </h2>

          <!-- Message -->
          <p class="text-sm text-slate-600 dark:text-slate-400">
            {{ t('auth.confirmation_sent', { email }) }}
          </p>

          <!-- Success message -->
          <div v-if="resent" class="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
            {{ t('auth.resend_success') }}
          </div>

          <!-- Error -->
          <div v-if="error" class="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400" role="alert">
            {{ error }}
          </div>

          <!-- Resend button -->
          <button
            @click="handleResend"
            :disabled="loading || cooldown > 0"
            class="sb-btn sb-btn-primary w-full"
          >
            <template v-if="loading">{{ t('common.loading') }}</template>
            <template v-else-if="cooldown > 0">{{ t('auth.resend_cooldown') }} ({{ cooldown }}s)</template>
            <template v-else>{{ t('auth.resend_confirmation') }}</template>
          </button>

          <!-- Back to login -->
          <p class="text-center text-sm text-slate-500 dark:text-slate-400">
            <router-link :to="withCurrentDesign('/login', route.path)" class="font-medium text-brand-600 hover:text-brand-500 hover:underline dark:text-brand-400 dark:hover:text-brand-300">
              {{ t('auth.sign_in') }}
            </router-link>
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
