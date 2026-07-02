<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
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
const auth = useAuthStore()

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
    <h2 class="text-xl font-bold">{{ t('settings.security') }}</h2>

    <!-- ═══ Two-Factor Authentication ═══ -->
    <div class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
      <h3 class="text-lg font-semibold mb-1">{{ t('totp.title') }}</h3>
      <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">{{ t('totp.description') }}</p>

      <!-- Success -->
      <div v-if="totpSuccess" class="mb-4 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 text-sm">
        {{ totpSuccess }}
      </div>

      <!-- Error -->
      <div v-if="totpError" class="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
        {{ totpError }}
      </div>

      <!-- Idle: show status + action button -->
      <template v-if="totpStep === 'idle'">
        <div class="flex items-center gap-3 mb-4">
          <div class="w-3 h-3 rounded-full flex-shrink-0" :class="otpEnabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'" />
          <span class="text-sm" :class="otpEnabled ? 'text-green-700 dark:text-green-400' : 'text-gray-500 dark:text-gray-400'">
            {{ otpEnabled ? t('totp.enabled') : t('totp.disabled') }}
          </span>
        </div>

        <button
          v-if="!otpEnabled"
          @click="startSetup"
          :disabled="totpLoading"
          class="px-6 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold transition-colors disabled:opacity-50"
        >
          {{ totpLoading ? t('common.loading') : t('totp.setup') }}
        </button>

        <button
          v-else
          @click="totpStep = 'disable'; totpError = ''; totpSuccess = ''"
          class="px-6 py-2.5 rounded-lg border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 font-medium hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
        >
          {{ t('totp.disable') }}
        </button>
      </template>

      <!-- Setup: QR code + backup codes + confirm -->
      <template v-if="totpStep === 'setup'">
        <!-- Step 1: QR Code -->
        <div class="mb-6">
          <p class="text-sm text-gray-700 dark:text-gray-300 mb-3">{{ t('totp.step1') }}</p>
          <div class="flex justify-center mb-3">
            <img :src="generateQrSvg(totpUri)" alt="TOTP QR Code" class="w-48 h-48 rounded-lg border border-gray-200 dark:border-gray-700 bg-white" />
          </div>
          <div class="text-center">
            <p class="text-xs text-gray-500 dark:text-gray-400 mb-1">{{ t('totp.secret_label') }}</p>
            <code class="text-sm font-mono bg-gray-100 dark:bg-gray-900 px-3 py-1.5 rounded select-all break-all">{{ totpSecret }}</code>
          </div>
        </div>

        <!-- Backup codes -->
        <div class="mb-6 p-4 bg-yellow-50 dark:bg-yellow-900/10 border border-yellow-200 dark:border-yellow-800 rounded-lg">
          <h4 class="font-semibold text-sm text-yellow-800 dark:text-yellow-300 mb-1">{{ t('totp.backup_codes_title') }}</h4>
          <p class="text-xs text-yellow-700 dark:text-yellow-400 mb-2">{{ t('totp.backup_codes_description') }}</p>
          <p class="text-xs text-red-600 dark:text-red-400 font-medium mb-3">{{ t('totp.backup_codes_warning') }}</p>
          <div class="grid grid-cols-2 gap-1 mb-3">
            <code
              v-for="code in totpBackupCodes"
              :key="code"
              class="text-sm font-mono bg-white dark:bg-gray-900 px-2 py-1 rounded text-center"
            >{{ code }}</code>
          </div>
          <button
            @click="copyBackupCodes"
            class="text-sm font-medium transition-colors"
            :class="backupCodesCopied ? 'text-green-600 dark:text-green-400' : 'text-indigo-600 dark:text-indigo-400 hover:text-indigo-700'"
          >
            {{ backupCodesCopied ? t('totp.copied') : t('status.copyLink') }}
          </button>
        </div>

        <!-- Step 2: Verify code -->
        <div class="mb-4">
          <p class="text-sm text-gray-700 dark:text-gray-300 mb-2">{{ t('totp.step2') }}</p>
          <input
            v-model="totpCode"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="6"
            :placeholder="t('totp.code_placeholder')"
            class="w-full max-w-xs px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-mono text-lg tracking-widest text-center focus:outline-none focus:ring-2 focus:ring-indigo-500"
            @keyup.enter="confirmSetup"
          />
        </div>

        <div class="flex gap-2">
          <button
            @click="confirmSetup"
            :disabled="totpLoading || totpCode.length !== 6"
            class="px-6 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold transition-colors disabled:opacity-50"
          >
            {{ totpLoading ? t('common.loading') : t('totp.confirm') }}
          </button>
          <button
            @click="cancelSetup"
            class="px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            {{ t('totp.cancel_setup') }}
          </button>
        </div>
      </template>

      <!-- Disable: password confirmation -->
      <template v-if="totpStep === 'disable'">
        <p class="text-sm text-gray-700 dark:text-gray-300 mb-3">{{ t('totp.disable_confirm') }}</p>
        <input
          v-model="disablePassword"
          type="password"
          :placeholder="t('totp.disable_password')"
          class="w-full max-w-xs px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 mb-4"
          @keyup.enter="disableTotp"
        />
        <div class="flex gap-2">
          <button
            @click="disableTotp"
            :disabled="totpLoading || !disablePassword"
            class="px-6 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-white font-bold transition-colors disabled:opacity-50"
          >
            {{ totpLoading ? t('common.loading') : t('totp.disable_submit') }}
          </button>
          <button
            @click="cancelSetup"
            class="px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            {{ t('common.cancel') }}
          </button>
        </div>
      </template>
    </div>

    <!-- ═══ Passkeys ═══ -->
    <div class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
      <h3 class="text-lg font-semibold mb-1">{{ t('webauthn.title') }}</h3>
      <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">{{ t('webauthn.description') }}</p>

      <!-- Success -->
      <div v-if="success" class="mb-4 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 text-sm">
        {{ success }}
      </div>

      <!-- Error -->
      <div v-if="error" class="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm" role="alert">
        {{ error }}
      </div>

      <!-- Loading -->
      <div v-if="loading" class="text-center py-4 text-gray-500 dark:text-gray-400">
        {{ t('common.loading') }}
      </div>

      <!-- Passkey list -->
      <div v-else-if="credentials.length > 0" class="space-y-3 mb-4">
        <div
          v-for="cred in credentials"
          :key="cred.id"
          class="flex items-center justify-between p-3 rounded-lg border border-gray-200 dark:border-gray-700"
        >
          <div class="min-w-0">
            <p class="font-medium text-sm text-gray-900 dark:text-white truncate">
              {{ cred.name || cred.device_type || 'Passkey' }}
            </p>
            <p class="text-xs text-gray-500 dark:text-gray-400">
              {{ formatDate(cred.created_at) }}
              <template v-if="cred.last_used_at"> &middot; Last used {{ formatDate(cred.last_used_at) }}</template>
            </p>
          </div>
          <div class="flex-shrink-0 ml-3">
            <button
              v-if="confirmRemoveId === cred.id"
              @click="handleRemovePasskey(cred.id)"
              :disabled="removingId === cred.id"
              class="px-3 py-1.5 rounded-lg text-sm font-medium text-red-600 dark:text-red-400 border border-red-300 dark:border-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
            >
              {{ removingId === cred.id ? t('common.loading') : t('common.confirm') }}
            </button>
            <button
              v-else
              @click="confirmRemoveId = cred.id"
              class="px-3 py-1.5 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-400 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              {{ t('webauthn.remove') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Empty state -->
      <div v-else class="text-center py-6 text-gray-500 dark:text-gray-400 text-sm mb-4">
        {{ t('webauthn.no_passkeys') }}
      </div>

      <!-- Add passkey -->
      <div v-if="supportsPasskeys">
        <div v-if="showNameInput" class="space-y-3">
          <div>
            <label for="passkey-name" class="block text-sm font-medium mb-1">{{ t('webauthn.name_label') }}</label>
            <input
              id="passkey-name"
              v-model="passkeyName"
              type="text"
              :placeholder="t('webauthn.name_placeholder')"
              class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div class="flex gap-2">
            <button
              @click="handleAddPasskey"
              :disabled="addingPasskey"
              class="px-6 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold transition-colors disabled:opacity-50"
            >
              {{ addingPasskey ? t('common.loading') : t('common.confirm') }}
            </button>
            <button
              @click="showNameInput = false; passkeyName = ''"
              class="px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              {{ t('common.cancel') }}
            </button>
          </div>
        </div>

        <button
          v-else
          @click="showNameInput = true"
          class="w-full py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 font-medium hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        >
          {{ t('webauthn.add') }}
        </button>
      </div>

      <div v-else class="text-sm text-gray-500 dark:text-gray-400">
        {{ t('webauthn.error_not_supported') }}
      </div>
    </div>

    <!-- ═══ Active Sessions ═══ -->
    <div class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
      <h3 class="text-lg font-semibold mb-1">{{ t('sessions.title') }}</h3>
      <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">{{ t('sessions.description') }}</p>

      <!-- Success -->
      <div v-if="sessionsSuccess" class="mb-4 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 text-sm">
        {{ sessionsSuccess }}
      </div>

      <!-- Error -->
      <div v-if="sessionsError" class="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
        {{ sessionsError }}
      </div>

      <!-- Loading -->
      <div v-if="sessionsLoading" class="text-center py-4 text-gray-500 dark:text-gray-400">
        {{ t('common.loading') }}
      </div>

      <!-- Session list -->
      <div v-else-if="sessions.length > 0" class="space-y-3 mb-4">
        <div
          v-for="session in sessions"
          :key="session.id"
          class="p-3 rounded-lg border transition-colors"
          :class="session.current
            ? 'border-indigo-300 dark:border-indigo-700 bg-indigo-50/50 dark:bg-indigo-900/10'
            : 'border-gray-200 dark:border-gray-700'"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 mb-1">
                <p class="font-medium text-sm text-gray-900 dark:text-white">
                  {{ session.application_name }}
                </p>
                <span v-if="session.current" class="text-xs px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 font-medium">
                  {{ t('sessions.current') }}
                </span>
              </div>
              <div class="text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
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
                class="px-3 py-1.5 rounded-lg text-sm font-medium text-red-600 dark:text-red-400 border border-red-300 dark:border-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
              >
                {{ revokingId === session.id ? t('common.loading') : t('common.confirm') }}
              </button>
              <button
                v-else
                @click="confirmRevokeId = session.id"
                class="px-3 py-1.5 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-400 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                {{ t('sessions.revoke') }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Empty state -->
      <div v-else class="text-center py-6 text-gray-500 dark:text-gray-400 text-sm mb-4">
        {{ t('sessions.no_sessions') }}
      </div>

      <!-- Revoke all -->
      <button
        v-if="sessions.filter(s => !s.current).length > 0"
        @click="handleRevokeAll"
        class="w-full py-2.5 rounded-lg border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 font-medium hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
      >
        {{ t('sessions.revoke_all') }}
      </button>
    </div>
  </div>
</template>
