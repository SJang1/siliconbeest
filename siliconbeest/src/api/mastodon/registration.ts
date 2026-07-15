import { apiFetch } from '../client';
import type {
  EmailVerificationState,
  InvitationPreview,
  RegistrationActivation,
  RegistrationCancelledResponse,
  RegistrationCompletion,
  RegistrationContinueResponse,
  RegistrationSession,
} from '@/types/registration';

export function previewInvitation(token: string) {
  return apiFetch<InvitationPreview>(
    `/v1/registration/invitations/${encodeURIComponent(token)}`,
  );
}

export function getRegistrationSession() {
  return apiFetch<RegistrationSession>('/v1/registration');
}

export function completeRegistration(ticket: string) {
  return apiFetch<RegistrationCompletion>('/v1/registration/completion', {
    method: 'POST',
    body: { ticket },
  });
}

export function continueRegistration() {
  return apiFetch<RegistrationContinueResponse>('/v1/registration/continue', {
    method: 'POST',
  });
}

export function verifyRegistrationEmail(code: string) {
  return apiFetch<RegistrationActivation>('/v1/registration/verify', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

export function resendRegistrationEmail() {
  return apiFetch<EmailVerificationState>('/v1/registration/resend', {
    method: 'POST',
  });
}

export function cancelRegistration() {
  return apiFetch<RegistrationCancelledResponse>('/v1/registration/cancel', {
    method: 'POST',
  });
}

export function logoutRegistration() {
  return apiFetch<Record<string, never>>('/v1/registration/logout', {
    method: 'POST',
  });
}
