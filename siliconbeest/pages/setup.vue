<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { usePublicInstance } from '@/composables/usePublicInstance';

definePageMeta({ name: 'setup' });

type SetupStatus = {
  setup_required: boolean;
  user_count: number;
};

type SetupResponse = {
  access_token: string;
  token_type: 'Bearer';
  scope: string;
  created_at: number;
};

const router = useRouter();
const { t, locale } = useI18n();
const auth = useAuthStore();
const setupStatus = useState<SetupStatus | null>('setup-status', () => null);
const { data: instance } = await usePublicInstance();
const setupDone = useCookie<string | null>('siliconbeest_setup_done', {
  path: '/',
  sameSite: 'lax',
});

if (!setupStatus.value) {
  try {
    setupStatus.value = await $fetch<SetupStatus>('/api/v1/setup');
  } catch {
    setupStatus.value = null;
  }
}

if (setupStatus.value?.setup_required === false) {
  setupDone.value = '1';
}

useHead({
  script: [{ src: '/setup-form.js', defer: true }],
});

const form = reactive({
  username: 'admin',
  email: '',
  password: '',
  confirmPassword: '',
  setupSecret: '',
});
const loading = ref(false);
const error = ref<string | null>(null);

const instanceTitle = computed(() => instance.value?.title ?? '');
const setupAvailable = computed(() => setupStatus.value?.setup_required !== false);

onMounted(() => {
  (window as Window & { __SILICONBEEST_SETUP_VUE_READY__?: boolean }).__SILICONBEEST_SETUP_VUE_READY__ = true;
});

function validateForm(): string | null {
  if (!form.username.trim()) return t('setup.username_required');
  if (!/^[a-zA-Z0-9_]+$/.test(form.username.trim())) {
    return t('setup.username_invalid');
  }
  if (!form.email.trim()) return t('setup.email_required');
  if (!form.setupSecret.trim()) return t('setup.secret_required');
  if (!form.password) return t('setup.password_required');
  if (form.password.length < 8) return t('setup.password_too_short');
  if (form.password !== form.confirmPassword) return t('setup.password_mismatch');
  return null;
}

async function refreshStatus() {
  setupStatus.value = await $fetch<SetupStatus>('/api/v1/setup');
}

async function createAdmin() {
  if (loading.value) return;

  error.value = validateForm();
  if (error.value) return;

  loading.value = true;
  error.value = null;
  try {
    const data = await $fetch<SetupResponse>('/api/v1/setup', {
      method: 'POST',
      body: {
        username: form.username.trim(),
        email: form.email.trim(),
        password: form.password,
        locale: locale.value,
        setup_secret: form.setupSecret.trim(),
      },
    });
    auth.setToken(data.access_token);
    setupStatus.value = { setup_required: false, user_count: 1 };
    setupDone.value = '1';
    await auth.fetchCurrentUser();
    await router.push('/home');
  } catch (e) {
    const fetchError = e as { data?: { error?: string; error_description?: string }; message?: string };
    if (fetchError.data?.error || fetchError.data?.error_description) {
      error.value = fetchError.data.error_description ?? fetchError.data.error ?? null;
    } else {
      error.value = fetchError.message ?? t('setup.create_failed');
    }
    await refreshStatus().catch(() => {});
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="sb-app relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-12">
    <div class="sb-aurora" aria-hidden="true"></div>

    <div class="relative z-10 mx-auto w-full max-w-md animate-rise-in">
      <div class="mb-8 text-center">
        <h1 v-if="instanceTitle" class="sb-heading sb-gradient-text text-3xl">
          {{ instanceTitle }}
        </h1>
        <p class="mt-3 text-sm text-slate-500 dark:text-slate-400">
          {{ t('setup.subtitle') }}
        </p>
      </div>

      <div class="sb-card p-6 sm:p-8">
        <div
          v-if="!setupAvailable"
          class="rounded-xl bg-surface-2 p-4 text-sm text-slate-700 dark:bg-surface-2-dark dark:text-slate-200"
        >
          {{ t('setup.unavailable') }}
        </div>

        <form
          v-else
          id="setup-admin-form"
          data-setup-endpoint="/api/v1/setup"
          novalidate
          class="space-y-5"
          @submit.prevent.stop="createAdmin"
        >
          <div
            id="setup-static-error"
            class="hidden rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-400"
          ></div>

          <div
            v-if="error"
            class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-400"
          >
            {{ error }}
          </div>

          <div>
            <label for="setup-username" class="sb-label">{{ t('setup.admin_username') }}</label>
            <input
              id="setup-username"
              v-model="form.username"
              name="username"
              autocomplete="username"
              class="sb-input"
              required
            />
          </div>

          <div>
            <label for="setup-email" class="sb-label">{{ t('setup.admin_email') }}</label>
            <input
              id="setup-email"
              v-model="form.email"
              name="email"
              type="email"
              autocomplete="email"
              class="sb-input"
              required
            />
          </div>

          <div>
            <label for="setup-secret" class="sb-label">{{ t('setup.secret') }}</label>
            <input
              id="setup-secret"
              v-model="form.setupSecret"
              name="setup_secret"
              type="password"
              autocomplete="one-time-code"
              class="sb-input"
              required
            />
          </div>

          <div>
            <label for="setup-password" class="sb-label">{{ t('setup.password') }}</label>
            <input
              id="setup-password"
              v-model="form.password"
              name="password"
              type="password"
              autocomplete="new-password"
              class="sb-input"
              required
            />
          </div>

          <div>
            <label for="setup-confirm-password" class="sb-label">{{ t('setup.confirm_password') }}</label>
            <input
              id="setup-confirm-password"
              v-model="form.confirmPassword"
              name="confirmPassword"
              type="password"
              autocomplete="new-password"
              class="sb-input"
              required
            />
          </div>

          <input type="hidden" name="locale" :value="locale" />

          <button
            type="button"
            data-setup-submit
            :disabled="loading"
            class="sb-btn sb-btn-primary w-full py-3 text-base"
            @click="createAdmin"
          >
            {{ loading ? t('setup.creating') : t('setup.create') }}
          </button>
        </form>
      </div>
    </div>
  </div>
</template>
