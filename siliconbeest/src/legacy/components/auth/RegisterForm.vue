<script setup lang="ts">
import { ref } from 'vue'
import RegisterForm from '@/components/auth/RegisterForm.vue'
import type { InstanceRule } from '@/types/mastodon'
import type { InvitationPreview, RegistrationFormData, RegistrationMode } from '@/types/registration'

const props = defineProps<{
  registrationOpen?: boolean
  registrationMode?: RegistrationMode
  registrationMessage?: string
  rules?: InstanceRule[]
  termsOfService?: string
  privacyPolicy?: string
  invitation?: InvitationPreview | null
}>()

const emit = defineEmits<{
  submit: [data: RegistrationFormData]
}>()

const form = ref<InstanceType<typeof RegisterForm> | null>(null)

function finishSubmission(resetCaptcha = false) {
  form.value?.finishSubmission(resetCaptcha)
}

defineExpose({ finishSubmission })
</script>

<template>
  <RegisterForm
    ref="form"
    v-bind="props"
    @submit="emit('submit', $event)"
  />
</template>
