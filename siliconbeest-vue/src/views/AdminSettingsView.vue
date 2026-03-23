<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { getAdminSettings, updateAdminSettings, testSmtp } from '@/api/mastodon/admin'

const { t } = useI18n()
const auth = useAuthStore()

const loading = ref(true)
const saving = ref(false)
const error = ref('')
const success = ref('')
const smtpTesting = ref(false)
const smtpTestResult = ref('')

const settings = ref({
  // Site Info
  site_title: '',
  site_description: '',
  site_contact_email: '',
  site_contact_username: '',
  // Branding
  site_favicon_url: '',
  site_logo_url: '',
  site_theme_color: '#6366f1',
  // Registration
  registration_mode: 'closed',
  // Limits
  max_toot_chars: '500',
  max_media_attachments: '4',
  // SMTP
  smtp_host: '',
  smtp_port: '587',
  smtp_username: '',
  smtp_password: '',
  smtp_from_address: '',
})

onMounted(async () => {
  try {
    const { data } = await getAdminSettings(auth.token!)
    Object.assign(settings.value, data)
  } catch (e: any) {
    error.value = e?.description || e?.error || t('common.error')
  } finally {
    loading.value = false
  }
})

async function handleSave() {
  saving.value = true
  error.value = ''
  success.value = ''
  try {
    await updateAdminSettings(auth.token!, { ...settings.value })
    success.value = t('admin_settings.saved')
  } catch (e: any) {
    error.value = e?.description || e?.error || t('common.error')
  } finally {
    saving.value = false
  }
}

async function handleTestSmtp() {
  smtpTesting.value = true
  smtpTestResult.value = ''
  try {
    await testSmtp(auth.token!)
    smtpTestResult.value = t('admin_settings.smtp_test_success')
  } catch {
    smtpTestResult.value = t('admin_settings.smtp_test_fail')
  } finally {
    smtpTesting.value = false
  }
}

const inputClass = 'w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500'
const labelClass = 'block text-sm font-medium mb-1'
</script>

<template>
  <div class="max-w-4xl mx-auto">
    <h1 class="text-2xl font-bold mb-6">{{ t('admin.instanceSettings') }}</h1>

    <div v-if="loading" class="text-gray-500">{{ t('common.loading') }}</div>

    <form v-else @submit.prevent="handleSave" class="space-y-8">
      <!-- Global messages -->
      <div v-if="success" class="p-3 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 text-sm">
        {{ success }}
      </div>
      <div v-if="error" class="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm" role="alert">
        {{ error }}
      </div>

      <!-- Site Info -->
      <section class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
        <h2 class="text-lg font-semibold mb-4">{{ t('admin_settings.site_info') }}</h2>
        <div class="space-y-4">
          <div>
            <label :class="labelClass">site_title</label>
            <input v-model="settings.site_title" :class="inputClass" />
          </div>
          <div>
            <label :class="labelClass">site_description</label>
            <textarea v-model="settings.site_description" rows="3" :class="inputClass" />
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label :class="labelClass">site_contact_email</label>
              <input v-model="settings.site_contact_email" type="email" :class="inputClass" />
            </div>
            <div>
              <label :class="labelClass">site_contact_username</label>
              <input v-model="settings.site_contact_username" :class="inputClass" />
            </div>
          </div>
        </div>
      </section>

      <!-- Branding -->
      <section class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
        <h2 class="text-lg font-semibold mb-4">{{ t('admin_settings.branding') }}</h2>
        <div class="space-y-4">
          <div>
            <label :class="labelClass">site_favicon_url</label>
            <input v-model="settings.site_favicon_url" type="url" :class="inputClass" placeholder="https://..." />
          </div>
          <div>
            <label :class="labelClass">site_logo_url</label>
            <input v-model="settings.site_logo_url" type="url" :class="inputClass" placeholder="https://..." />
          </div>
          <div>
            <label :class="labelClass">site_theme_color</label>
            <div class="flex items-center gap-3">
              <input v-model="settings.site_theme_color" type="color" class="h-10 w-14 rounded border border-gray-300 dark:border-gray-600 cursor-pointer" />
              <input v-model="settings.site_theme_color" :class="inputClass" class="!w-40" />
            </div>
          </div>
        </div>
      </section>

      <!-- Registration -->
      <section class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
        <h2 class="text-lg font-semibold mb-4">{{ t('admin_settings.registration') }}</h2>
        <div>
          <label :class="labelClass">registration_mode</label>
          <select v-model="settings.registration_mode" :class="inputClass" class="!w-64">
            <option value="open">{{ t('admin.registrationMode.open') }}</option>
            <option value="approval">{{ t('admin.registrationMode.approval') }}</option>
            <option value="closed">{{ t('admin.registrationMode.closed') }}</option>
          </select>
        </div>
      </section>

      <!-- Limits -->
      <section class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
        <h2 class="text-lg font-semibold mb-4">{{ t('admin_settings.limits') }}</h2>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label :class="labelClass">max_toot_chars</label>
            <input v-model="settings.max_toot_chars" type="number" min="1" :class="inputClass" />
          </div>
          <div>
            <label :class="labelClass">max_media_attachments</label>
            <input v-model="settings.max_media_attachments" type="number" min="0" :class="inputClass" />
          </div>
        </div>
      </section>

      <!-- SMTP -->
      <section class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
        <h2 class="text-lg font-semibold mb-4">{{ t('admin_settings.smtp') }}</h2>
        <div class="space-y-4">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label :class="labelClass">smtp_host</label>
              <input v-model="settings.smtp_host" :class="inputClass" placeholder="smtp.example.com" />
            </div>
            <div>
              <label :class="labelClass">smtp_port</label>
              <input v-model="settings.smtp_port" type="number" :class="inputClass" />
            </div>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label :class="labelClass">smtp_username</label>
              <input v-model="settings.smtp_username" :class="inputClass" />
            </div>
            <div>
              <label :class="labelClass">smtp_password</label>
              <input v-model="settings.smtp_password" type="password" :class="inputClass" />
            </div>
          </div>
          <div>
            <label :class="labelClass">smtp_from_address</label>
            <input v-model="settings.smtp_from_address" type="email" :class="inputClass" placeholder="noreply@example.com" />
          </div>
          <div class="flex items-center gap-4">
            <button
              type="button"
              :disabled="smtpTesting"
              @click="handleTestSmtp"
              class="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
            >
              {{ smtpTesting ? t('common.loading') : t('admin_settings.smtp_test') }}
            </button>
            <span v-if="smtpTestResult" class="text-sm" :class="smtpTestResult === t('admin_settings.smtp_test_success') ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">
              {{ smtpTestResult }}
            </span>
          </div>
        </div>
      </section>

      <!-- Save -->
      <div class="flex justify-end">
        <button
          type="submit"
          :disabled="saving"
          class="px-8 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold transition-colors disabled:opacity-50"
        >
          {{ saving ? t('common.loading') : t('admin_settings.save') }}
        </button>
      </div>
    </form>
  </div>
</template>
