<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
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
    // 1. Get registration options from server
    const { data: options } = await getRegisterOptions(auth.token)

    // 2. Convert base64url values to ArrayBuffers for WebAuthn API
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

    // 3. Create credential via browser API
    const credential = (await navigator.credentials.create({
      publicKey: publicKeyOptions,
    })) as PublicKeyCredential | null

    if (!credential) {
      error.value = t('webauthn.error_cancelled')
      return
    }

    const response = credential.response as AuthenticatorAttestationResponse

    // 4. Serialize credential for the server
    const serialized = {
      id: credential.id,
      rawId: base64urlEncode(credential.rawId),
      type: credential.type,
      response: {
        attestationObject: base64urlEncode(response.attestationObject),
        clientDataJSON: base64urlEncode(response.clientDataJSON),
      },
    }

    // 5. Verify with server
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

onMounted(loadCredentials)
</script>

<template>
  <div class="space-y-6">
    <h2 class="text-xl font-bold">{{ t('settings.security') }}</h2>

    <!-- Passkeys Section -->
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
        <!-- Name input (shown before adding) -->
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

    <!-- Two-Factor Authentication: TODO — implement TOTP setup UI -->
  </div>
</template>
