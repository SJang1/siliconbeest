<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { apiFetch } from '@/api/client'
import { useInstanceStore } from '@/stores/instance'
import { withCurrentDesign } from '@/utils/safeRedirect'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const instanceStore = useInstanceStore()

const token = computed(() => (route.query.token as string) || '')
const instanceTitle = computed(() => instanceStore.instance?.title)
const newPassword = ref('')
const confirmPassword = ref('')
const loading = ref(false)
const error = ref('')
const success = ref(false)

async function handleSubmit() {
  error.value = ''

  if (newPassword.value !== confirmPassword.value) {
    error.value = t('auth.passwords_no_match')
    return
  }

  if (!token.value) {
    error.value = t('passwords.reset_expired')
    return
  }

  loading.value = true
  try {
    await apiFetch('/v1/auth/passwords/reset', {
      method: 'POST',
      body: JSON.stringify({
        token: token.value,
        password: newPassword.value,
      }),
    })
    success.value = true
    setTimeout(() => router.push(withCurrentDesign('/login', route.path)), 2000)
  } catch (e: any) {
    if (e?.status === 410 || e?.status === 400) {
      error.value = t('passwords.reset_expired')
    } else {
      error.value = e?.description || e?.error || t('common.error')
    }
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="sb-app relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-12">
    <div class="sb-aurora" aria-hidden="true"></div>
    <div class="relative z-10 w-full max-w-md animate-rise-in">
      <div class="mb-8 text-center">
        <h1 class="sb-heading sb-gradient-text text-4xl">{{ instanceTitle }}</h1>
        <p class="mt-3 text-sm text-slate-500 dark:text-slate-400">{{ t('passwords.reset_title') }}</p>
      </div>
      <div class="sb-card p-8">
        <!-- Success -->
        <div v-if="success" class="space-y-4">
          <div class="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
            {{ t('passwords.reset_success') }}
          </div>
          <router-link
            :to="withCurrentDesign('/login', route.path)"
            class="block text-center text-sm font-medium text-brand-600 hover:text-brand-500 hover:underline dark:text-brand-400 dark:hover:text-brand-300"
          >
            {{ t('auth.sign_in') }}
          </router-link>
        </div>

        <!-- Form -->
        <form v-else @submit.prevent="handleSubmit" class="space-y-5">
          <div v-if="error" class="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400" role="alert">
            {{ error }}
          </div>

          <div>
            <label for="reset-password" class="sb-label">{{ t('passwords.new_password') }}</label>
            <input
              id="reset-password"
              v-model="newPassword"
              type="password"
              required
              autocomplete="new-password"
              class="sb-input"
            />
          </div>

          <div>
            <label for="reset-confirm" class="sb-label">{{ t('passwords.confirm_new_password') }}</label>
            <input
              id="reset-confirm"
              v-model="confirmPassword"
              type="password"
              required
              autocomplete="new-password"
              class="sb-input"
            />
          </div>

          <button
            type="submit"
            :disabled="loading"
            class="sb-btn sb-btn-primary w-full"
          >
            {{ loading ? t('common.loading') : t('passwords.reset_submit') }}
          </button>

          <p class="text-center text-sm text-slate-500 dark:text-slate-400">
            <router-link :to="withCurrentDesign('/login', route.path)" class="font-medium text-brand-600 hover:text-brand-500 hover:underline dark:text-brand-400 dark:hover:text-brand-300">
              {{ t('auth.sign_in') }}
            </router-link>
          </p>
        </form>
      </div>
    </div>
  </div>
</template>
