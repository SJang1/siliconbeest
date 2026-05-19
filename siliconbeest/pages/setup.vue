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
const { locale } = useI18n();
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
});
const loading = ref(false);
const error = ref<string | null>(null);

const instanceTitle = computed(() => instance.value?.title ?? '');
const setupAvailable = computed(() => setupStatus.value?.setup_required !== false);

onMounted(() => {
  (window as Window & { __SILICONBEEST_SETUP_VUE_READY__?: boolean }).__SILICONBEEST_SETUP_VUE_READY__ = true;
});

function validateForm(): string | null {
  if (!form.username.trim()) return '사용자 이름을 입력해 주세요.';
  if (!/^[a-zA-Z0-9_]+$/.test(form.username.trim())) {
    return '사용자 이름은 영문, 숫자, 밑줄만 사용할 수 있습니다.';
  }
  if (!form.email.trim()) return '이메일을 입력해 주세요.';
  if (!form.password) return '비밀번호를 입력해 주세요.';
  if (form.password.length < 8) return '비밀번호는 8자 이상이어야 합니다.';
  if (form.password !== form.confirmPassword) return '비밀번호 확인이 일치하지 않습니다.';
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
      error.value = fetchError.message ?? '관리자 생성에 실패했습니다.';
    }
    await refreshStatus().catch(() => {});
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen bg-gray-50 px-4 py-12 text-gray-900 dark:bg-gray-900 dark:text-gray-100">
    <div class="mx-auto w-full max-w-md">
      <div class="mb-8 text-center">
        <h1 v-if="instanceTitle" class="text-3xl font-bold text-indigo-600 dark:text-indigo-400">
          {{ instanceTitle }}
        </h1>
        <p class="mt-3 text-sm text-gray-500 dark:text-gray-400">
          첫 관리자 계정을 생성합니다.
        </p>
      </div>

      <div class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div
          v-if="!setupAvailable"
          class="rounded-lg bg-gray-100 p-4 text-sm text-gray-700 dark:bg-gray-700 dark:text-gray-200"
        >
          이미 사용자가 생성되어 초기 설정을 사용할 수 없습니다.
        </div>

        <form
          v-else
          id="setup-admin-form"
          data-setup-endpoint="/api/v1/setup"
          novalidate
          class="space-y-4"
          @submit.prevent.stop="createAdmin"
        >
          <div
            id="setup-static-error"
            class="hidden rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400"
          ></div>

          <div
            v-if="error"
            class="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400"
          >
            {{ error }}
          </div>

          <div>
            <label for="setup-username" class="mb-1 block text-sm font-medium">관리자 사용자 이름</label>
            <input
              id="setup-username"
              v-model="form.username"
              name="username"
              autocomplete="username"
              class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-900"
              required
            />
          </div>

          <div>
            <label for="setup-email" class="mb-1 block text-sm font-medium">관리자 이메일</label>
            <input
              id="setup-email"
              v-model="form.email"
              name="email"
              type="email"
              autocomplete="email"
              class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-900"
              required
            />
          </div>

          <div>
            <label for="setup-password" class="mb-1 block text-sm font-medium">비밀번호</label>
            <input
              id="setup-password"
              v-model="form.password"
              name="password"
              type="password"
              autocomplete="new-password"
              class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-900"
              required
            />
          </div>

          <div>
            <label for="setup-confirm-password" class="mb-1 block text-sm font-medium">비밀번호 확인</label>
            <input
              id="setup-confirm-password"
              v-model="form.confirmPassword"
              name="confirmPassword"
              type="password"
              autocomplete="new-password"
              class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-900"
              required
            />
          </div>

          <input type="hidden" name="locale" :value="locale" />

          <button
            type="button"
            data-setup-submit
            :disabled="loading"
            class="w-full rounded-full bg-indigo-600 px-4 py-3 font-bold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
            @click="createAdmin"
          >
            {{ loading ? '생성 중...' : '관리자 생성' }}
          </button>
        </form>
      </div>
    </div>
  </div>
</template>
