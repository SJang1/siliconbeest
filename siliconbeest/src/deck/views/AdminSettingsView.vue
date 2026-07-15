<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { getAdminSettings, updateAdminSettings, testSmtp } from '@/api/mastodon/admin'
import { uploadMedia } from '@/api/mastodon/media'
import DeckAdminLayout from '@/deck/layout/DeckAdminLayout.vue'
import AdminInvitationSettingsFields from '@/components/admin/AdminInvitationSettingsFields.vue'
import { createDefaultInvitationAdminSettings } from '@/types/registration'

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
  accent_color: '#6366f1',
  site_landing_markdown: '',
  terms_of_service: '',
  privacy_policy: '',
  registration_mode: 'closed',
  registration_message: '',
  require_email_verification: '1',
  ...createDefaultInvitationAdminSettings(),
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
  vapid_private_key: '',
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
    await updateAdminSettings(auth.token!, settings.value)
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

const inputClass = 'sb-input'
const labelClass = 'sb-label'
const ACCENT_PRESETS = ['#6366f1', '#c6f24e', '#4ed9c6', '#ff8a5c']
const toggleClass =
  "peer h-6 w-11 rounded-full bg-slate-200 transition-colors after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-outline after:bg-white after:transition-all after:content-[''] peer-checked:bg-brand-600 peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-brand-400 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-white dark:bg-slate-700 dark:after:border-outline-dark dark:peer-checked:bg-brand-500 dark:peer-focus-visible:ring-offset-surface-dark"
</script>

<template>
  <DeckAdminLayout>
  <div class="w-full max-w-5xl animate-fade-in">
    <h1 class="sb-heading mb-6 text-2xl text-slate-900 dark:text-white">{{ t('admin_settings.title') }}</h1>

    <div v-if="loading" class="text-sm text-slate-500 dark:text-slate-400">{{ t('common.loading') }}</div>

    <form v-else @submit.prevent="handleSave" class="space-y-6">
      <!-- Global messages -->
      <div v-if="success" class="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300">
        {{ success }}
      </div>
      <div v-if="error" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300" role="alert">
        {{ error }}
      </div>

      <!-- Site Info -->
      <section class="sb-card p-6">
        <h2 class="sb-heading mb-4 text-lg text-slate-900 dark:text-white">{{ t('admin_settings.site_info') }}</h2>
        <div class="space-y-4">
          <div>
            <label :class="labelClass">{{ t('admin_settings.fields.site_title') }}</label>
            <input v-model="settings.site_title" :class="inputClass" />
          </div>
          <div>
            <label :class="labelClass">{{ t('admin_settings.fields.site_description') }}</label>
            <textarea v-model="settings.site_description" rows="3" :class="inputClass" />
          </div>
          <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
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
      <section class="sb-card p-6">
        <h2 class="sb-heading mb-4 text-lg text-slate-900 dark:text-white">{{ t('admin_settings.branding') }}</h2>
        <div class="space-y-4">
          <div>
            <label :class="labelClass">{{ t('admin_settings.fields.favicon') }}</label>
            <div class="flex items-center gap-2">
              <input v-model="settings.site_favicon_url" type="url" :class="inputClass" class="flex-1" placeholder="https://..." />
              <label class="sb-btn sb-btn-secondary cursor-pointer whitespace-nowrap" :class="faviconUploading ? 'pointer-events-none opacity-50' : ''">
                {{ faviconUploading ? '...' : t('common.upload') }}
                <input type="file" accept="image/*" class="hidden" @change="uploadImage($event, 'site_favicon_url')" />
              </label>
              <img :src="settings.site_favicon_url || '/favicon.ico'" class="h-9 w-9 rounded-lg border border-outline object-contain dark:border-outline-dark" alt="favicon" />
            </div>
          </div>
          <div>
            <label :class="labelClass">{{ t('admin_settings.fields.logo') }}</label>
            <div class="flex items-center gap-2">
              <input v-model="settings.site_logo_url" type="url" :class="inputClass" class="flex-1" placeholder="https://..." />
              <label class="sb-btn sb-btn-secondary cursor-pointer whitespace-nowrap" :class="logoUploading ? 'pointer-events-none opacity-50' : ''">
                {{ logoUploading ? '...' : t('common.upload') }}
                <input type="file" accept="image/*" class="hidden" @change="uploadImage($event, 'site_logo_url')" />
              </label>
              <img :src="settings.site_logo_url || '/thumbnail.png'" class="h-9 w-9 rounded-lg border border-outline object-contain dark:border-outline-dark" alt="logo" />
            </div>
          </div>
          <div>
            <label :class="labelClass">{{ t('admin_settings.fields.theme_color') }}</label>
            <div class="flex items-center gap-3">
              <input v-model="settings.site_theme_color" type="color" class="h-10 w-14 cursor-pointer rounded-xl border border-outline bg-surface dark:border-outline-dark dark:bg-surface-2-dark" />
              <input v-model="settings.site_theme_color" :class="inputClass" class="!w-40" />
            </div>
          </div>
          <div>
            <label :class="labelClass">{{ t('admin_settings.fields.accent_color') }}</label>
            <div class="flex flex-wrap items-center gap-3">
              <div class="flex items-center gap-1.5" role="group" :aria-label="t('admin_settings.fields.accent_color')">
                <button
                  v-for="preset in ACCENT_PRESETS"
                  :key="preset"
                  type="button"
                  class="h-8 w-8 rounded-full border-2 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                  :class="settings.accent_color === preset ? 'border-slate-900 dark:border-white' : 'border-outline dark:border-outline-dark'"
                  :style="{ backgroundColor: preset }"
                  :aria-label="preset"
                  :aria-pressed="settings.accent_color === preset"
                  @click="settings.accent_color = preset"
                />
              </div>
              <input v-model="settings.accent_color" type="color" class="h-10 w-14 cursor-pointer rounded-xl border border-outline bg-surface dark:border-outline-dark dark:bg-surface-2-dark" />
              <input v-model="settings.accent_color" :class="inputClass" class="!w-40" placeholder="#6366f1" />
            </div>
            <p class="mt-1.5 text-xs text-slate-500 dark:text-slate-400">{{ t('admin_settings.accent_color_hint') }}</p>
          </div>
        </div>
      </section>

      <!-- Landing Page & Legal -->
      <section class="sb-card p-6">
        <h2 class="sb-heading mb-4 text-lg text-slate-900 dark:text-white">{{ t('admin_settings.landing_legal') }}</h2>
        <div class="space-y-4">
          <div>
            <label :class="labelClass">{{ t('admin_settings.fields.site_landing_markdown') }}</label>
            <p class="mb-1.5 text-xs text-slate-500 dark:text-slate-400">{{ t('admin_settings.fields.site_landing_markdown_desc') }}</p>
            <textarea v-model="settings.site_landing_markdown" rows="6" :class="inputClass" :placeholder="t('admin_settings.fields.site_landing_markdown_placeholder')" />
          </div>
          <div>
            <label :class="labelClass">{{ t('admin_settings.fields.terms_of_service') }}</label>
            <p class="mb-1.5 text-xs text-slate-500 dark:text-slate-400">{{ t('admin_settings.fields.terms_of_service_desc') }}</p>
            <textarea v-model="settings.terms_of_service" rows="8" :class="inputClass" />
          </div>
          <div>
            <label :class="labelClass">{{ t('admin_settings.fields.privacy_policy') }}</label>
            <p class="mb-1.5 text-xs text-slate-500 dark:text-slate-400">{{ t('admin_settings.fields.privacy_policy_desc') }}</p>
            <textarea v-model="settings.privacy_policy" rows="8" :class="inputClass" />
          </div>
        </div>
      </section>

      <!-- Registration -->
      <section class="sb-card p-6">
        <h2 class="sb-heading mb-4 text-lg text-slate-900 dark:text-white">{{ t('admin_settings.registration') }}</h2>
        <div class="space-y-4">
          <div>
            <label :class="labelClass">{{ t('admin_settings.fields.registration_mode') }}</label>
            <select v-model="settings.registration_mode" :class="inputClass" class="!w-64">
              <option value="open">{{ t('admin_settings.reg_open') }}</option>
              <option value="approval">{{ t('admin_settings.reg_approval') }}</option>
              <option value="referral">{{ t('admin_settings.reg_referral') }}</option>
              <option value="closed">{{ t('admin_settings.reg_closed') }}</option>
            </select>
          </div>
          <div>
            <label :class="labelClass">{{ t('admin_settings.fields.registration_message') }}</label>
            <textarea v-model="settings.registration_message" rows="3" :class="inputClass" :placeholder="t('admin_settings.registration_message_help')" />
          </div>
          <label class="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              :checked="settings.require_email_verification === '1'"
              class="mt-0.5 h-4 w-4 rounded border-outline text-brand-600 accent-brand-600 dark:border-outline-dark dark:bg-surface-2-dark"
              @change="settings.require_email_verification = ($event.target as HTMLInputElement).checked ? '1' : '0'"
            />
            <span>
              <span class="block text-sm font-medium text-slate-900 dark:text-white">{{ t('admin_settings.fields.require_email_verification') }}</span>
              <span class="mt-1 block text-xs text-slate-500 dark:text-slate-400">{{ t('admin_settings.require_email_verification_help') }}</span>
            </span>
          </label>
        </div>
      </section>

      <AdminInvitationSettingsFields :settings="settings" />

      <!-- Limits -->
      <section class="sb-card p-6">
        <h2 class="sb-heading mb-4 text-lg text-slate-900 dark:text-white">{{ t('admin_settings.limits') }}</h2>
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
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
      <section class="sb-card p-6">
        <h2 class="sb-heading mb-4 text-lg text-slate-900 dark:text-white">{{ t('admin_settings.smtp') }}</h2>
        <div class="space-y-4">
          <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label :class="labelClass">{{ t('admin_settings.fields.smtp_host') }}</label>
              <input v-model="settings.smtp_host" :class="inputClass" placeholder="smtp.example.com" />
            </div>
            <div>
              <label :class="labelClass">{{ t('admin_settings.fields.smtp_port') }}</label>
              <input v-model="settings.smtp_port" type="number" :class="inputClass" />
            </div>
          </div>
          <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
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
                <option value="auto">{{ t('common.auto') }}</option>
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
              class="sb-btn sb-btn-secondary"
            >
              {{ smtpTesting ? t('common.loading') : t('admin_settings.smtp_test') }}
            </button>
            <span v-if="smtpTestResult" class="text-sm font-medium" :class="smtpTestResult === t('admin_settings.smtp_test_success') ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'">
              {{ smtpTestResult }}
            </span>
          </div>
        </div>
      </section>

      <!-- Turnstile (CAPTCHA) -->
      <section class="sb-card p-6">
        <h2 class="sb-heading mb-2 text-lg text-slate-900 dark:text-white">{{ t('turnstile.title') }}</h2>
        <p class="mb-4 text-sm text-slate-500 dark:text-slate-400">{{ t('turnstile.description') }}</p>
        <div class="space-y-4">
          <div class="flex items-center gap-3">
            <label class="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                :checked="settings.turnstile_enabled === '1'"
                @change="settings.turnstile_enabled = ($event.target as HTMLInputElement).checked ? '1' : '0'"
                class="peer sr-only"
              />
              <div :class="toggleClass"></div>
            </label>
            <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('turnstile.enabled') }}</span>
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
            class="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
          >
            {{ t('turnstile.get_keys') }} &rarr;
          </a>
        </div>
      </section>

      <!-- Web Push -->
      <section class="sb-card p-6">
        <h2 class="sb-heading mb-2 text-lg text-slate-900 dark:text-white">{{ t('admin_settings.web_push') }}</h2>
        <p class="mb-4 text-sm text-slate-500 dark:text-slate-400">{{ t('admin_settings.web_push_description') }}</p>
        <div class="space-y-4">
          <div class="flex items-center gap-3">
            <label class="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                :checked="settings.web_push_enabled === '1'"
                @change="settings.web_push_enabled = ($event.target as HTMLInputElement).checked ? '1' : '0'"
                class="peer sr-only"
              />
              <div :class="toggleClass"></div>
            </label>
            <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('admin_settings.web_push_enabled') }}</span>
          </div>
          <div>
            <label :class="labelClass">{{ t('admin_settings.fields.vapid_public_key') }}</label>
            <input v-model="settings.vapid_public_key" :class="inputClass" :placeholder="t('admin_settings.vapid_public_key_placeholder')" />
          </div>
          <div>
            <label :class="labelClass">{{ t('admin_settings.fields.vapid_private_key') }}</label>
            <input v-model="settings.vapid_private_key" type="password" :class="inputClass" :placeholder="t('admin_settings.vapid_private_key_placeholder')" />
          </div>
          <p class="text-xs text-slate-500 dark:text-slate-400">
            {{ t('admin_settings.vapid_help') }}
          </p>
        </div>
      </section>

      <!-- Save -->
      <div class="flex justify-end">
        <button
          type="submit"
          :disabled="saving"
          class="sb-btn sb-btn-primary px-8"
        >
          {{ saving ? t('common.loading') : t('common.save') }}
        </button>
      </div>
    </form>
  </div>
  </DeckAdminLayout>
</template>
