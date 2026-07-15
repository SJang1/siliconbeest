<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { getSafeRedirect, withCurrentDesign } from '@/utils/safeRedirect'
import { mfaSetup, mfaConfirm, mfaDisable } from '@/api/mastodon/mfa'
import { listSessions as fetchSessions, revokeSession as apiRevokeSession, revokeAllOtherSessions, type Session } from '@/api/mastodon/sessions'
import {
  listCredentials,
  getRegisterOptions,
  verifyRegistration,
  deleteCredential,
  base64urlEncode,
  base64urlDecode,
  type WebAuthnCredential,
} from '@/api/mastodon/webauthn'

const { t } = useI18n()
const route = useRoute()
const auth = useAuthStore()

const hasOnboardingRedirect = computed(() => route.query.redirect !== undefined)
const onboardingTarget = computed(() => withCurrentDesign(
  getSafeRedirect(route.query.redirect, '/home'),
  route.path,
))

// ── Passkeys ──
const credentials = ref<WebAuthnCredential[]>([])
const loading = ref(false)
const error = ref('')
const success = ref('')
const showNameInput = ref(false)
const passkeyName = ref('')
const addingPasskey = ref(false)
const removingId = ref<string | null>(null)
const confirmRemoveId = ref<string | null>(null)

const supportsPasskeys = typeof window !== 'undefined' && !!window.PublicKeyCredential

async function loadCredentials() {
  if (!auth.token) return
  loading.value = true
  error.value = ''
  try {
    const { data } = await listCredentials(auth.token)
    credentials.value = data
  } catch (e: any) {
    error.value = e?.error || t('common.error')
  } finally {
    loading.value = false
  }
}

async function handleAddPasskey() {
  if (!auth.token) return
  addingPasskey.value = true
  error.value = ''
  success.value = ''
  try {
    const { data: options } = await getRegisterOptions(auth.token)
    const publicKeyOptions: PublicKeyCredentialCreationOptions = {
      rp: options.rp,
      user: {
        id: base64urlDecode(options.user.id),
        name: options.user.name,
        displayName: options.user.displayName,
      },
      challenge: base64urlDecode(options.challenge),
      pubKeyCredParams: options.pubKeyCredParams as PublicKeyCredentialParameters[],
      timeout: options.timeout,
      excludeCredentials: options.excludeCredentials?.map((c) => ({
        id: base64urlDecode(c.id),
        type: c.type as PublicKeyCredentialType,
        transports: c.transports as AuthenticatorTransport[] | undefined,
      })),
      authenticatorSelection: options.authenticatorSelection as AuthenticatorSelectionCriteria | undefined,
      attestation: (options.attestation as AttestationConveyancePreference) || 'none',
    }
    const credential = (await navigator.credentials.create({
      publicKey: publicKeyOptions,
    })) as PublicKeyCredential | null
    if (!credential) {
      error.value = t('webauthn.error_cancelled')
      return
    }
    const response = credential.response as AuthenticatorAttestationResponse
    const serialized = {
      id: credential.id,
      rawId: base64urlEncode(credential.rawId),
      type: credential.type,
      response: {
        attestationObject: base64urlEncode(response.attestationObject),
        clientDataJSON: base64urlEncode(response.clientDataJSON),
      },
    }
    await verifyRegistration(auth.token, serialized, passkeyName.value || undefined)
    success.value = t('webauthn.added')
    showNameInput.value = false
    passkeyName.value = ''
    await loadCredentials()
  } catch (e: any) {
    if (e?.name === 'NotAllowedError') {
      error.value = t('webauthn.error_cancelled')
    } else {
      error.value = e?.error || e?.message || t('webauthn.error_failed')
    }
  } finally {
    addingPasskey.value = false
  }
}

async function handleRemovePasskey(id: string) {
  if (!auth.token) return
  removingId.value = id
  error.value = ''
  success.value = ''
  try {
    await deleteCredential(auth.token, id)
    success.value = t('webauthn.removed')
    confirmRemoveId.value = null
    await loadCredentials()
  } catch (e: any) {
    error.value = e?.error || t('common.error')
  } finally {
    removingId.value = null
  }
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString()
}

// ── TOTP 2FA ──
const otpEnabled = computed(() => !!auth.currentUser?.otp_enabled)

type TotpStep = 'idle' | 'setup' | 'confirm' | 'disable'
const totpStep = ref<TotpStep>('idle')
const totpSecret = ref('')
const totpUri = ref('')
const totpBackupCodes = ref<string[]>([])
const totpCode = ref('')
const totpError = ref('')
const totpSuccess = ref('')
const totpLoading = ref(false)
const disablePassword = ref('')
const backupCodesCopied = ref(false)

async function startSetup() {
  if (!auth.token) return
  totpLoading.value = true
  totpError.value = ''
  try {
    const { data } = await mfaSetup(auth.token)
    totpSecret.value = data.secret
    totpUri.value = data.uri
    totpBackupCodes.value = data.backup_codes
    totpStep.value = 'setup'
  } catch (e: any) {
    totpError.value = e?.error || t('common.error')
  } finally {
    totpLoading.value = false
  }
}

async function confirmSetup() {
  if (!auth.token || !totpCode.value) return
  totpLoading.value = true
  totpError.value = ''
  try {
    await mfaConfirm(auth.token, totpCode.value)
    totpSuccess.value = t('totp.setup_success')
    totpStep.value = 'idle'
    totpCode.value = ''
    await auth.fetchCurrentUser()
  } catch (e: any) {
    totpError.value = e?.error || t('totp.invalid_code')
  } finally {
    totpLoading.value = false
  }
}

async function disableTotp() {
  if (!auth.token || !disablePassword.value) return
  totpLoading.value = true
  totpError.value = ''
  try {
    await mfaDisable(auth.token, disablePassword.value)
    totpSuccess.value = t('totp.disable_success')
    totpStep.value = 'idle'
    disablePassword.value = ''
    await auth.fetchCurrentUser()
  } catch (e: any) {
    totpError.value = e?.error || t('common.error')
  } finally {
    totpLoading.value = false
  }
}

function cancelSetup() {
  totpStep.value = 'idle'
  totpSecret.value = ''
  totpUri.value = ''
  totpBackupCodes.value = []
  totpCode.value = ''
  totpError.value = ''
  disablePassword.value = ''
}

async function copyBackupCodes() {
  const text = totpBackupCodes.value.join('\n')
  try {
    await navigator.clipboard.writeText(text)
    backupCodesCopied.value = true
    setTimeout(() => { backupCodesCopied.value = false }, 2000)
  } catch { /* ignore */ }
}

// Generate QR code as SVG using a simple inline implementation
function generateQrSvg(uri: string): string {
  // Use a data URI to render QR code via an image tag pointing to a Google Charts API
  // This avoids needing a QR library dependency
  const encoded = encodeURIComponent(uri)
  return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encoded}`
}

// ── Sessions ──
const sessions = ref<Session[]>([])
const sessionsLoading = ref(false)
const sessionsError = ref('')
const sessionsSuccess = ref('')
const confirmRevokeId = ref<string | null>(null)
const revokingId = ref<string | null>(null)

async function loadSessions() {
  if (!auth.token) return
  sessionsLoading.value = true
  sessionsError.value = ''
  try {
    const { data } = await fetchSessions(auth.token)
    sessions.value = data
  } catch (e: any) {
    sessionsError.value = e?.error || t('common.error')
  } finally {
    sessionsLoading.value = false
  }
}

async function handleRevokeSession(id: string) {
  if (!auth.token) return
  revokingId.value = id
  sessionsError.value = ''
  sessionsSuccess.value = ''
  try {
    await apiRevokeSession(auth.token, id)
    sessionsSuccess.value = t('sessions.revoked')
    confirmRevokeId.value = null
    await loadSessions()
  } catch (e: any) {
    sessionsError.value = e?.error || t('common.error')
  } finally {
    revokingId.value = null
  }
}

async function handleRevokeAll() {
  if (!auth.token) return
  sessionsError.value = ''
  sessionsSuccess.value = ''
  try {
    const { data } = await revokeAllOtherSessions(auth.token)
    sessionsSuccess.value = t('sessions.revoked_all', { count: data.revoked })
    await loadSessions()
  } catch (e: any) {
    sessionsError.value = e?.error || t('common.error')
  }
}

function formatSessionDate(dateStr: string | null) {
  if (!dateStr) return t('sessions.unknown')
  return new Date(dateStr).toLocaleString()
}

function parseUserAgent(ua: string | null): string {
  if (!ua) return t('sessions.unknown')
  // Simple UA parsing — extract browser and OS
  const match = ua.match(/(Chrome|Firefox|Safari|Edge|Opera|MSIE|Trident)[\/\s]?(\d+)?/i)
  if (match) return match[0]
  return ua.length > 60 ? ua.substring(0, 60) + '...' : ua
}

onMounted(() => {
  loadCredentials()
  loadSessions()
})
</script>

<template>
  <div class="space-y-6">
    <h2 class="sb-heading text-xl">{{ t('settings.security') }}</h2>

    <!-- ═══ Two-Factor Authentication ═══ -->
    <div class="sb-card p-6">
      <h3 class="sb-heading text-lg mb-1">{{ t('totp.title') }}</h3>
      <p class="text-sm text-slate-500 dark:text-slate-400 mb-4">{{ t('totp.description') }}</p>

      <!-- Success -->
      <div v-if="totpSuccess" class="mb-4 p-3 rounded-xl bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-400 text-sm">
        {{ totpSuccess }}
      </div>

      <!-- Error -->
      <div v-if="totpError" class="mb-4 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-sm">
        {{ totpError }}
      </div>

      <!-- Idle: show status + action button -->
      <template v-if="totpStep === 'idle'">
        <div class="flex items-center gap-3 mb-4">
          <div class="w-3 h-3 rounded-full flex-shrink-0" :class="otpEnabled ? 'bg-green-500' : 'bg-slate-300 dark:bg-slate-600'" />
          <span class="text-sm" :class="otpEnabled ? 'text-green-700 dark:text-green-400' : 'text-slate-500 dark:text-slate-400'">
            {{ otpEnabled ? t('totp.enabled') : t('totp.disabled') }}
          </span>
        </div>

        <button
          v-if="!otpEnabled"
          @click="startSetup"
          :disabled="totpLoading"
          class="sb-btn sb-btn-primary px-6"
        >
          {{ totpLoading ? t('common.loading') : t('totp.setup') }}
        </button>

        <button
          v-else
          @click="totpStep = 'disable'; totpError = ''; totpSuccess = ''"
          class="sb-btn border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40 px-6"
        >
          {{ t('totp.disable') }}
        </button>
      </template>

      <!-- Setup: QR code + backup codes + confirm -->
      <template v-if="totpStep === 'setup'">
        <!-- Step 1: QR Code -->
        <div class="mb-6">
          <p class="text-sm text-slate-700 dark:text-slate-200 mb-3">{{ t('totp.step1') }}</p>
          <div class="flex justify-center mb-3">
            <img :src="generateQrSvg(totpUri)" :alt="t('totp.qr_alt')" class="w-48 h-48 rounded-xl border border-outline dark:border-outline-dark bg-white shadow-soft" />
          </div>
          <div class="text-center">
            <p class="text-xs text-slate-500 dark:text-slate-400 mb-1">{{ t('totp.secret_label') }}</p>
            <code class="text-sm font-mono bg-surface-2 dark:bg-surface-2-dark px-3 py-1.5 rounded-lg select-all break-all">{{ totpSecret }}</code>
          </div>
        </div>

        <!-- Backup codes -->
        <div class="mb-6 p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-xl">
          <h4 class="font-semibold text-sm text-amber-800 dark:text-amber-300 mb-1">{{ t('totp.backup_codes_title') }}</h4>
          <p class="text-xs text-amber-700 dark:text-amber-400 mb-2">{{ t('totp.backup_codes_description') }}</p>
          <p class="text-xs text-red-600 dark:text-red-400 font-medium mb-3">{{ t('totp.backup_codes_warning') }}</p>
          <div class="grid grid-cols-2 gap-1 mb-3">
            <code
              v-for="code in totpBackupCodes"
              :key="code"
              class="text-sm font-mono bg-surface dark:bg-surface-2-dark px-2 py-1 rounded-lg text-center"
            >{{ code }}</code>
          </div>
          <button
            @click="copyBackupCodes"
            class="text-sm font-semibold transition-colors"
            :class="backupCodesCopied ? 'text-green-600 dark:text-green-400' : 'text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300'"
          >
            {{ backupCodesCopied ? t('totp.copied') : t('status.copyLink') }}
          </button>
        </div>

        <!-- Step 2: Verify code -->
        <div class="mb-4">
          <p class="text-sm text-slate-700 dark:text-slate-200 mb-2">{{ t('totp.step2') }}</p>
          <input
            v-model="totpCode"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="6"
            :placeholder="t('totp.code_placeholder')"
            class="sb-input max-w-xs font-mono text-lg tracking-widest text-center"
            @keyup.enter="confirmSetup"
          />
        </div>

        <div class="flex gap-2">
          <button
            @click="confirmSetup"
            :disabled="totpLoading || totpCode.length !== 6"
            class="sb-btn sb-btn-primary px-6"
          >
            {{ totpLoading ? t('common.loading') : t('totp.confirm') }}
          </button>
          <button
            @click="cancelSetup"
            class="sb-btn sb-btn-secondary"
          >
            {{ t('totp.cancel_setup') }}
          </button>
        </div>
      </template>

      <!-- Disable: password confirmation -->
      <template v-if="totpStep === 'disable'">
        <p class="text-sm text-slate-700 dark:text-slate-200 mb-3">{{ t('totp.disable_confirm') }}</p>
        <input
          v-model="disablePassword"
          type="password"
          :placeholder="t('totp.disable_password')"
          class="sb-input max-w-xs mb-4"
          @keyup.enter="disableTotp"
        />
        <div class="flex gap-2">
          <button
            @click="disableTotp"
            :disabled="totpLoading || !disablePassword"
            class="sb-btn sb-btn-danger px-6"
          >
            {{ totpLoading ? t('common.loading') : t('totp.disable_submit') }}
          </button>
          <button
            @click="cancelSetup"
            class="sb-btn sb-btn-secondary"
          >
            {{ t('common.cancel') }}
          </button>
        </div>
      </template>
    </div>

    <!-- ═══ Passkeys ═══ -->
    <div class="sb-card p-6">
      <h3 class="sb-heading text-lg mb-1">{{ t('webauthn.title') }}</h3>
      <p class="text-sm text-slate-500 dark:text-slate-400 mb-4">{{ t('webauthn.description') }}</p>

      <!-- Success -->
      <div v-if="success" class="mb-4 p-3 rounded-xl bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-400 text-sm">
        {{ success }}
      </div>

      <!-- Error -->
      <div v-if="error" class="mb-4 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-sm" role="alert">
        {{ error }}
      </div>

      <!-- Loading -->
      <div v-if="loading" class="text-center py-4 text-slate-500 dark:text-slate-400">
        {{ t('common.loading') }}
      </div>

      <!-- Passkey list -->
      <div v-else-if="credentials.length > 0" class="space-y-3 mb-4">
        <div
          v-for="cred in credentials"
          :key="cred.id"
          class="flex items-center justify-between p-3 rounded-xl border border-outline dark:border-outline-dark"
        >
          <div class="min-w-0">
            <p class="font-medium text-sm text-slate-900 dark:text-slate-100 truncate">
              {{ cred.name || cred.device_type || 'Passkey' }}
            </p>
            <p class="text-xs text-slate-500 dark:text-slate-400">
              {{ formatDate(cred.created_at) }}
              <template v-if="cred.last_used_at"> &middot; Last used {{ formatDate(cred.last_used_at) }}</template>
            </p>
          </div>
          <div class="flex-shrink-0 ml-3">
            <button
              v-if="confirmRemoveId === cred.id"
              @click="handleRemovePasskey(cred.id)"
              :disabled="removingId === cred.id"
              class="sb-btn sb-btn-sm border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              {{ removingId === cred.id ? t('common.loading') : t('common.confirm') }}
            </button>
            <button
              v-else
              @click="confirmRemoveId = cred.id"
              class="sb-btn sb-btn-secondary sb-btn-sm"
            >
              {{ t('webauthn.remove') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Empty state -->
      <div v-else class="text-center py-6 text-slate-500 dark:text-slate-400 text-sm mb-4">
        {{ t('webauthn.no_passkeys') }}
      </div>

      <!-- Add passkey -->
      <div v-if="supportsPasskeys">
        <div v-if="showNameInput" class="space-y-3">
          <div>
            <label for="passkey-name" class="sb-label">{{ t('webauthn.name_label') }}</label>
            <input
              id="passkey-name"
              v-model="passkeyName"
              type="text"
              :placeholder="t('webauthn.name_placeholder')"
              class="sb-input"
            />
          </div>
          <div class="flex gap-2">
            <button
              @click="handleAddPasskey"
              :disabled="addingPasskey"
              class="sb-btn sb-btn-primary px-6"
            >
              {{ addingPasskey ? t('common.loading') : t('common.confirm') }}
            </button>
            <button
              @click="showNameInput = false; passkeyName = ''"
              class="sb-btn sb-btn-secondary"
            >
              {{ t('common.cancel') }}
            </button>
          </div>
        </div>

        <button
          v-else
          @click="showNameInput = true"
          class="sb-btn sb-btn-secondary w-full"
        >
          {{ t('webauthn.add') }}
        </button>
      </div>

      <div v-else class="text-sm text-slate-500 dark:text-slate-400">
        {{ t('webauthn.error_not_supported') }}
      </div>
    </div>

    <div v-if="hasOnboardingRedirect" class="rounded-xl border border-brand-200 bg-brand-50 p-4 dark:border-brand-500/30 dark:bg-brand-950/40">
      <p class="text-sm text-slate-600 dark:text-slate-300">
        {{ t('auth.registration_passkey_description') }}
      </p>
      <router-link :to="onboardingTarget" class="sb-btn sb-btn-primary mt-3">
        {{ t('auth.registration_finish') }}
      </router-link>
    </div>

    <!-- ═══ Active Sessions ═══ -->
    <div class="sb-card p-6">
      <h3 class="sb-heading text-lg mb-1">{{ t('sessions.title') }}</h3>
      <p class="text-sm text-slate-500 dark:text-slate-400 mb-4">{{ t('sessions.description') }}</p>

      <!-- Success -->
      <div v-if="sessionsSuccess" class="mb-4 p-3 rounded-xl bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-400 text-sm">
        {{ sessionsSuccess }}
      </div>

      <!-- Error -->
      <div v-if="sessionsError" class="mb-4 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-sm">
        {{ sessionsError }}
      </div>

      <!-- Loading -->
      <div v-if="sessionsLoading" class="text-center py-4 text-slate-500 dark:text-slate-400">
        {{ t('common.loading') }}
      </div>

      <!-- Session list -->
      <div v-else-if="sessions.length > 0" class="space-y-3 mb-4">
        <div
          v-for="session in sessions"
          :key="session.id"
          class="p-3 rounded-xl border transition-colors"
          :class="session.current
            ? 'border-brand-300 dark:border-brand-800 bg-brand-50/50 dark:bg-brand-950/20'
            : 'border-outline dark:border-outline-dark'"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 mb-1">
                <p class="font-medium text-sm text-slate-900 dark:text-slate-100">
                  {{ session.application_name }}
                </p>
                <span v-if="session.current" class="sb-chip">
                  {{ t('sessions.current') }}
                </span>
              </div>
              <div class="text-xs text-slate-500 dark:text-slate-400 space-y-0.5">
                <p><span class="font-medium">{{ t('sessions.device') }}:</span> {{ parseUserAgent(session.user_agent) }}</p>
                <p><span class="font-medium">{{ t('sessions.ip') }}:</span> {{ session.ip || t('sessions.unknown') }}</p>
                <p><span class="font-medium">{{ t('sessions.created') }}:</span> {{ formatSessionDate(session.created_at) }}</p>
                <p v-if="session.last_used_at"><span class="font-medium">{{ t('sessions.last_used') }}:</span> {{ formatSessionDate(session.last_used_at) }}</p>
              </div>
            </div>
            <div v-if="!session.current" class="flex-shrink-0">
              <button
                v-if="confirmRevokeId === session.id"
                @click="handleRevokeSession(session.id)"
                :disabled="revokingId === session.id"
                class="sb-btn sb-btn-sm border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40"
              >
                {{ revokingId === session.id ? t('common.loading') : t('common.confirm') }}
              </button>
              <button
                v-else
                @click="confirmRevokeId = session.id"
                class="sb-btn sb-btn-secondary sb-btn-sm"
              >
                {{ t('sessions.revoke') }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Empty state -->
      <div v-else class="text-center py-6 text-slate-500 dark:text-slate-400 text-sm mb-4">
        {{ t('sessions.no_sessions') }}
      </div>

      <!-- Revoke all -->
      <button
        v-if="sessions.filter(s => !s.current).length > 0"
        @click="handleRevokeAll"
        class="sb-btn w-full border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40"
      >
        {{ t('sessions.revoke_all') }}
      </button>
    </div>
  </div>
</template>
