<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { getAdminSettings, updateAdminSettings, testSmtp } from '@/api/mastodon/admin'
import { uploadMedia } from '@/api/mastodon/media'
import AdminLayout from '@/components/layout/AdminLayout.vue'

const { t } = useI18n()
const auth = useAuthStore()
const faviconUploading = ref(false)
const logoUploading = ref(false)

const loading = ref(true)
const saving = ref(false)
const error = ref('')
const success = ref('')
const smtpTesting = ref(false)
const smtpTestResult = ref('')

const settings = ref({
  site_title: '',
  site_description: '',
  site_contact_email: '',
  site_contact_username: '',
  site_favicon_url: '',
  site_logo_url: '',
  site_theme_color: '#6366f1',
  registration_mode: 'closed',
  max_toot_chars: '500',
  max_media_attachments: '4',
  smtp_host: '',
  smtp_port: '587',
  smtp_username: '',
  smtp_password: '',
  smtp_from_address: '',
  smtp_secure: 'false',
  smtp_auth_type: 'auto',
  turnstile_enabled: '0',
  turnstile_site_key: '',
  turnstile_secret_key: '',
  web_push_enabled: '0',
  vapid_public_key: '',
})

async function uploadImage(event: Event, field: 'site_favicon_url' | 'site_logo_url') {
  const input = event.target as HTMLInputElement
  if (!input.files?.[0] || !auth.token) return

  const loadingRef = field === 'site_favicon_url' ? faviconUploading : logoUploading
  loadingRef.value = true
  try {
    // Use dedicated admin upload endpoints for favicon/thumbnail
    const endpoint = field === 'site_favicon_url'
      ? '/v1/admin/settings/favicon'
      : '/v1/admin/settings/thumbnail'
    const formData = new FormData()
    formData.append('file', input.files[0])
    const res = await fetch(`/api${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}` },
      body: formData,
    })
    if (!res.ok) throw new Error('Upload failed')
    const data = await res.json() as { url: string }
    settings.value[field] = data.url
  } catch (e: any) {
    error.value = e?.message || 'Upload failed'
  } finally {
    loadingRef.value = false
    input.value = ''
  }
}

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
    const { vapid_public_key: _, ...settingsToSave } = settings.value
    await updateAdminSettings(auth.token!, settingsToSave)
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
  <AdminLayout>
  <div class="w-full p-6">
    <h1 class="text-2xl font-bold mb-6">{{ t('admin_settings.title') }}</h1>

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
            <label :class="labelClass">{{ t('admin_settings.fields.site_title') }}</label>
            <input v-model="settings.site_title" :class="inputClass" />
          </div>
          <div>
            <label :class="labelClass">{{ t('admin_settings.fields.site_description') }}</label>
            <textarea v-model="settings.site_description" rows="3" :class="inputClass" />
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label :class="labelClass">{{ t('admin_settings.fields.contact_email') }}</label>
              <input v-model="settings.site_contact_email" type="email" :class="inputClass" />
            </div>
            <div>
              <label :class="labelClass">{{ t('admin_settings.fields.contact_username') }}</label>
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
            <label :class="labelClass">{{ t('admin_settings.fields.favicon') }}</label>
            <div class="flex items-center gap-2">
              <input v-model="settings.site_favicon_url" type="url" :class="inputClass" class="flex-1" placeholder="https://..." />
              <label class="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors whitespace-nowrap" :class="faviconUploading ? 'opacity-50 pointer-events-none' : ''">
                {{ faviconUploading ? '...' : t('common.upload') }}
                <input type="file" accept="image/*" class="hidden" @change="uploadImage($event, 'site_favicon_url')" />
              </label>
              <img v-if="settings.site_favicon_url" :src="settings.site_favicon_url" class="w-8 h-8 rounded object-contain border border-gray-200 dark:border-gray-700" alt="favicon" />
            </div>
          </div>
          <div>
            <label :class="labelClass">{{ t('admin_settings.fields.logo') }}</label>
            <div class="flex items-center gap-2">
              <input v-model="settings.site_logo_url" type="url" :class="inputClass" class="flex-1" placeholder="https://..." />
              <label class="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors whitespace-nowrap" :class="logoUploading ? 'opacity-50 pointer-events-none' : ''">
                {{ logoUploading ? '...' : t('common.upload') }}
                <input type="file" accept="image/*" class="hidden" @change="uploadImage($event, 'site_logo_url')" />
              </label>
              <img v-if="settings.site_logo_url" :src="settings.site_logo_url" class="w-8 h-8 rounded object-contain border border-gray-200 dark:border-gray-700" alt="logo" />
            </div>
          </div>
          <div>
            <label :class="labelClass">{{ t('admin_settings.fields.theme_color') }}</label>
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
          <label :class="labelClass">{{ t('admin_settings.fields.registration_mode') }}</label>
          <select v-model="settings.registration_mode" :class="inputClass" class="!w-64">
            <option value="open">{{ t('admin_settings.reg_open') }}</option>
            <option value="approval">{{ t('admin_settings.reg_approval') }}</option>
            <option value="closed">{{ t('admin_settings.reg_closed') }}</option>
          </select>
        </div>
      </section>

      <!-- Limits -->
      <section class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
        <h2 class="text-lg font-semibold mb-4">{{ t('admin_settings.limits') }}</h2>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label :class="labelClass">{{ t('admin_settings.fields.max_chars') }}</label>
            <input v-model="settings.max_toot_chars" type="number" min="1" :class="inputClass" />
          </div>
          <div>
            <label :class="labelClass">{{ t('admin_settings.fields.max_media') }}</label>
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
              <label :class="labelClass">{{ t('admin_settings.fields.smtp_host') }}</label>
              <input v-model="settings.smtp_host" :class="inputClass" placeholder="smtp.example.com" />
            </div>
            <div>
              <label :class="labelClass">{{ t('admin_settings.fields.smtp_port') }}</label>
              <input v-model="settings.smtp_port" type="number" :class="inputClass" />
            </div>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label :class="labelClass">{{ t('admin_settings.fields.smtp_username') }}</label>
              <input v-model="settings.smtp_username" :class="inputClass" />
            </div>
            <div>
              <label :class="labelClass">{{ t('admin_settings.fields.smtp_password') }}</label>
              <input v-model="settings.smtp_password" type="password" :class="inputClass" />
            </div>
          </div>
          <div>
            <label :class="labelClass">{{ t('admin_settings.fields.smtp_from') }}</label>
            <input v-model="settings.smtp_from_address" type="email" :class="inputClass" placeholder="noreply@example.com" />
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label :class="labelClass">{{ t('admin_settings.fields.smtp_auth_type') }}</label>
              <select v-model="settings.smtp_auth_type" :class="inputClass">
                <option value="auto">Auto</option>
                <option value="plain">PLAIN</option>
                <option value="login">LOGIN</option>
                <option value="cram-md5">CRAM-MD5</option>
              </select>
            </div>
            <div>
              <label :class="labelClass">{{ t('admin_settings.fields.smtp_secure') }}</label>
              <select v-model="settings.smtp_secure" :class="inputClass">
                <option value="false">STARTTLS (port 587)</option>
                <option value="true">SSL/TLS (port 465)</option>
              </select>
            </div>
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

      <!-- Turnstile (CAPTCHA) -->
      <section class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
        <h2 class="text-lg font-semibold mb-4">{{ t('turnstile.title') }}</h2>
        <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">{{ t('turnstile.description') }}</p>
        <div class="space-y-4">
          <div class="flex items-center gap-3">
            <label class="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                :checked="settings.turnstile_enabled === '1'"
                @change="settings.turnstile_enabled = ($event.target as HTMLInputElement).checked ? '1' : '0'"
                class="sr-only peer"
              />
              <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-indigo-300 rounded-full peer dark:bg-gray-600 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-500 peer-checked:bg-indigo-600"></div>
            </label>
            <span class="text-sm font-medium">{{ t('turnstile.enabled') }}</span>
          </div>
          <div>
            <label :class="labelClass">{{ t('turnstile.site_key') }}</label>
            <input v-model="settings.turnstile_site_key" :class="inputClass" placeholder="0x4AAAAAAXXXXXXX" />
          </div>
          <div>
            <label :class="labelClass">{{ t('turnstile.secret_key') }}</label>
            <input v-model="settings.turnstile_secret_key" type="password" :class="inputClass" placeholder="0x4AAAAAAXXXXXXX" />
          </div>
          <a
            href="https://dash.cloudflare.com/?to=/:account/turnstile"
            target="_blank"
            rel="noopener noreferrer"
            class="text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            {{ t('turnstile.get_keys') }} &rarr;
          </a>
        </div>
      </section>

      <!-- Web Push -->
      <section class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
        <h2 class="text-lg font-semibold mb-4">{{ t('admin_settings.web_push') }}</h2>
        <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">{{ t('admin_settings.web_push_description') }}</p>
        <div class="space-y-4">
          <div class="flex items-center gap-3">
            <label class="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                :checked="settings.web_push_enabled === '1'"
                @change="settings.web_push_enabled = ($event.target as HTMLInputElement).checked ? '1' : '0'"
                class="sr-only peer"
              />
              <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-indigo-300 rounded-full peer dark:bg-gray-600 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-500 peer-checked:bg-indigo-600"></div>
            </label>
            <span class="text-sm font-medium">{{ t('admin_settings.web_push_enabled') }}</span>
          </div>
          <div v-if="settings.vapid_public_key">
            <label :class="labelClass">{{ t('admin_settings.vapid_public_key') }}</label>
            <input :value="settings.vapid_public_key" :class="inputClass" readonly class="!bg-gray-50 dark:!bg-gray-700/50 !text-gray-500 dark:!text-gray-400 !cursor-default" />
          </div>
          <p class="text-xs text-gray-500 dark:text-gray-400">
            {{ t('admin_settings.vapid_note') }}
          </p>
        </div>
      </section>

      <!-- Save -->
      <div class="flex justify-end">
        <button
          type="submit"
          :disabled="saving"
          class="px-8 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold transition-colors disabled:opacity-50"
        >
          {{ saving ? t('common.loading') : t('common.save') }}
        </button>
      </div>
    </form>
  </div>
  </AdminLayout>
</template>
