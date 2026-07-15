<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { findUsername } from '@/api/mastodon/oauth'
import { useInstanceStore } from '@/stores/instance'
import { withCurrentDesign } from '@/utils/safeRedirect'

const { t } = useI18n()
const route = useRoute()
const instanceStore = useInstanceStore()
const email = ref('')
const loading = ref(false)
const sent = ref(false)
const error = ref('')
const instanceTitle = computed(() => instanceStore.instance?.title)

async function handleSubmit() {
  if (!email.value) return
  loading.value = true
  error.value = ''
  try {
    await findUsername(email.value)
    sent.value = true
  } catch (e: any) {
    error.value = e?.message || t('common.error')
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
      </div>
      <div class="sb-card p-8">
        <h2 class="sb-heading mb-2 text-center text-xl text-slate-900 dark:text-white">{{ t('auth.find_username_title') }}</h2>
        <p class="mb-6 text-center text-sm text-slate-500 dark:text-slate-400">{{ t('auth.find_username_desc') }}</p>

        <div v-if="sent" class="rounded-xl bg-emerald-50 px-4 py-3 text-center text-sm text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
          {{ t('auth.find_username_sent') }}
        </div>

        <form v-else @submit.prevent="handleSubmit" class="space-y-5">
          <div v-if="error" class="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400">
            {{ error }}
          </div>

          <div>
            <label for="find-email" class="sb-label">{{ t('auth.email') }}</label>
            <input
              id="find-email"
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
            {{ loading ? t('common.loading') : t('auth.find_username_submit') }}
          </button>
        </form>

        <p class="mt-5 text-center text-sm text-slate-500 dark:text-slate-400">
          <router-link :to="withCurrentDesign('/login', route.path)" class="font-medium text-brand-600 hover:text-brand-500 hover:underline dark:text-brand-400 dark:hover:text-brand-300">
            {{ t('auth.sign_in') }}
          </router-link>
        </p>
      </div>
    </div>
  </div>
</template>
