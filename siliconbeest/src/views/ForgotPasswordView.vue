<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { apiFetch } from '@/api/client'
import { useInstanceStore } from '@/stores/instance'
import { withCurrentDesign } from '@/utils/safeRedirect'

const { t } = useI18n()
const route = useRoute()
const instanceStore = useInstanceStore()

const username = ref('')
const email = ref('')
const loading = ref(false)
const sent = ref(false)
const error = ref('')
const instanceTitle = computed(() => instanceStore.instance?.title)

async function handleSubmit() {
  if (!username.value || !email.value) return
  loading.value = true
  error.value = ''
  try {
    await apiFetch('/v1/auth/passwords', {
      method: 'POST',
      body: JSON.stringify({ username: username.value, email: email.value }),
    })
  } catch {
    // Always show success to avoid enumeration
  }
  sent.value = true
  loading.value = false
}
</script>

<template>
  <div class="sb-app relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-12">
    <div class="sb-aurora" aria-hidden="true"></div>
    <div class="relative z-10 w-full max-w-md animate-rise-in">
      <div class="mb-8 text-center">
        <h1 class="sb-heading sb-gradient-text text-4xl">{{ instanceTitle }}</h1>
        <p class="mt-3 text-sm text-slate-500 dark:text-slate-400">{{ t('passwords.forgot_title') }}</p>
      </div>
      <div class="sb-card p-8">
        <!-- Success message -->
        <div v-if="sent" class="space-y-4">
          <div class="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
            {{ t('passwords.reset_sent') }}
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
          <p class="text-sm text-slate-600 dark:text-slate-400">
            {{ t('passwords.forgot_description') }}
          </p>

          <div v-if="error" class="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400" role="alert">
            {{ error }}
          </div>

          <div>
            <label for="forgot-username" class="sb-label">{{ t('auth.username') }}</label>
            <input
              id="forgot-username"
              v-model="username"
              type="text"
              required
              autocomplete="username"
              class="sb-input"
              :placeholder="t('auth.username_placeholder')"
            />
          </div>

          <div>
            <label for="forgot-email" class="sb-label">{{ t('auth.email') }}</label>
            <input
              id="forgot-email"
              v-model="email"
              type="email"
              required
              autocomplete="email"
              class="sb-input"
              :placeholder="t('auth.email_placeholder')"
            />
          </div>

          <button
            type="submit"
            :disabled="loading"
            class="sb-btn sb-btn-primary w-full"
          >
            {{ loading ? t('common.loading') : t('passwords.send_reset') }}
          </button>

          <div class="flex justify-between text-sm">
            <router-link :to="withCurrentDesign('/auth/find-username', route.path)" class="font-medium text-brand-600 hover:text-brand-500 hover:underline dark:text-brand-400 dark:hover:text-brand-300">
              {{ t('auth.find_username') }}
            </router-link>
            <router-link :to="withCurrentDesign('/login', route.path)" class="font-medium text-brand-600 hover:text-brand-500 hover:underline dark:text-brand-400 dark:hover:text-brand-300">
              {{ t('auth.sign_in') }}
            </router-link>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>
