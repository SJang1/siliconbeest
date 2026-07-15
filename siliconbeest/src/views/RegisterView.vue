<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useInstanceStore } from '@/stores/instance'
import { usePublicInstance } from '@/composables/usePublicInstance'
import { previewInvitation } from '@/api/mastodon/registration'
import { getApiErrorMessage } from '@/utils/apiError'
import { getSafeRedirect, withCurrentDesign } from '@/utils/safeRedirect'
import { isAuroraDesignPath, isOldDesignPath } from '@/utils/designVersion'
import RegisterForm from '@/components/auth/RegisterForm.vue'
import type {
  InvitationPreview,
  RegistrationFormData,
  RegistrationMode,
  RegistrationDesign,
} from '@/types/registration'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const instanceStore = useInstanceStore()
const { data: ssrInstance } = await usePublicInstance()

const form = ref<InstanceType<typeof RegisterForm> | null>(null)
const error = ref('')
const invitation = ref<InvitationPreview | null>(null)
const invitationLoading = ref(false)
const invitationError = ref('')

const instance = computed(() => ssrInstance.value ?? instanceStore.instance)
const instanceTitle = computed(() => instance.value?.title)
const invitationToken = computed(() => {
  const value = route.query.invite
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
})
const redirectUri = computed(() => getSafeRedirect(route.query.redirect, '/home'))
const registrationDesign = computed<RegistrationDesign>(() => {
  if (isOldDesignPath(route.path)) return 'old'
  if (isAuroraDesignPath(route.path)) return 'aurora'
  return 'default'
})

const registrationMode = computed<RegistrationMode>(() => {
  const registrations = instance.value?.registrations
  if (registrations?.mode) return registrations.mode
  if (!registrations?.enabled) return 'closed'
  return registrations.approval_required ? 'approval' : 'open'
})

const registrationOpen = computed(() => {
  if (registrationMode.value === 'closed') return false
  if (invitationToken.value) {
    return !invitationLoading.value && !invitationError.value && !!invitation.value
  }
  return registrationMode.value === 'open' || registrationMode.value === 'approval'
})

async function loadInvitation() {
  invitation.value = null
  invitationError.value = ''
  if (!invitationToken.value) return

  invitationLoading.value = true
  try {
    const { data } = await previewInvitation(invitationToken.value)
    invitation.value = data
  } catch (requestError) {
    invitationError.value = getApiErrorMessage(
      requestError,
      t('auth.registration_invite_invalid'),
    )
  } finally {
    invitationLoading.value = false
  }
}

onMounted(loadInvitation)

watch(invitationToken, () => {
  if (typeof window !== 'undefined') void loadInvitation()
})

async function handleRegister(data: RegistrationFormData) {
  error.value = ''
  let failed = false
  try {
    const result = await auth.register({
      username: data.username,
      email: data.email,
      password: data.password,
      agreement: data.agreement,
      locale: data.locale,
      reason: data.reason,
      turnstile_token: data.turnstile_token,
      invite_token: invitation.value ? invitationToken.value : undefined,
      redirect_uri: redirectUri.value,
      design: registrationDesign.value,
    })

    if (result.type === 'registration_required') {
      await router.push(withCurrentDesign('/auth/registration', route.path))
      return
    }

    await router.push(withCurrentDesign(redirectUri.value, route.path))
  } catch (requestError) {
    failed = true
    error.value = getApiErrorMessage(requestError, t('common.error'))
  } finally {
    form.value?.finishSubmission(failed)
  }
}
</script>

<template>
  <div class="sb-app relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-12">
    <div class="sb-aurora" aria-hidden="true"></div>
    <div class="relative z-10 w-full max-w-2xl animate-rise-in">
      <div class="mb-8 text-center">
        <h1 class="sb-heading sb-gradient-text text-4xl">{{ instanceTitle }}</h1>
        <p class="mt-3 text-sm text-slate-500 dark:text-slate-400">{{ t('auth.join_us') }}</p>
      </div>
      <div class="sb-card p-6 sm:p-8">
        <div v-if="error" class="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400" role="alert">
          {{ error }}
        </div>
        <div v-if="invitationLoading" class="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
          {{ t('common.loading') }}
        </div>
        <div v-else-if="invitationError" class="space-y-4 text-center">
          <div class="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400" role="alert">
            {{ invitationError }}
          </div>
          <router-link :to="{ path: withCurrentDesign('/register', route.path), query: { redirect: redirectUri } }" class="sb-btn sb-btn-secondary">
            {{ t('auth.registration_without_invite') }}
          </router-link>
        </div>
        <RegisterForm
          v-else
          ref="form"
          :registration-open="registrationOpen"
          :registration-mode="registrationMode"
          :registration-message="instance?.registrations.message || ''"
          :rules="instance?.rules || []"
          :terms-of-service="instance?.terms_of_service || ''"
          :privacy-policy="instance?.privacy_policy || ''"
          :invitation="invitation"
          @submit="handleRegister"
        />
      </div>
    </div>
  </div>
</template>
