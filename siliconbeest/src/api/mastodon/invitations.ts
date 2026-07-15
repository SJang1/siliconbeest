import { apiFetch } from '../client';
import type {
  AdminInvitationCreditsPage,
  CreateInvitationInput,
  CreatedInvitation,
  InvitationAuditLogsPage,
  InvitationCreditAdjustmentInput,
  InvitationCreditBulkInput,
  InvitationCreditResetInput,
  InvitationCredits,
  InvitationSummary,
} from '@/types/registration';
import { buildQueryString } from '../client';

export function listInvitations(token: string) {
  return apiFetch<InvitationSummary[]>('/v1/invites', { token });
}

export function createInvitation(token: string, input: CreateInvitationInput) {
  return apiFetch<CreatedInvitation>('/v1/invites', {
    method: 'POST',
    token,
    body: JSON.stringify(input),
  });
}

export function revokeInvitation(token: string, invitationId: string) {
  return apiFetch<Record<string, never>>(
    `/v1/invites/${encodeURIComponent(invitationId)}`,
    { method: 'DELETE', token },
  );
}

export function getInvitationCredits(token: string) {
  return apiFetch<InvitationCredits>('/v1/invites/credits', { token });
}

export function getAdminInvitationCredits(
  token: string,
  params: { search?: string; limit: number; offset: number },
) {
  const query = buildQueryString(params);
  return apiFetch<AdminInvitationCreditsPage>(
    `/v1/admin/invitation-credits${query}`,
    { token },
  );
}

export function adjustAdminInvitationCredits(
  token: string,
  accountId: string,
  input: InvitationCreditAdjustmentInput,
) {
  return apiFetch<InvitationCredits>(
    `/v1/admin/invitation-credits/${encodeURIComponent(accountId)}`,
    { method: 'POST', token, body: JSON.stringify(input) },
  );
}

export function distributeAdminInvitationCredits(
  token: string,
  input: InvitationCreditBulkInput,
) {
  return apiFetch<{ updated: number }>('/v1/admin/invitation-credits/distribute', {
    method: 'POST',
    token,
    body: JSON.stringify(input),
  });
}

export function resetAdminInvitationCredits(
  token: string,
  input: InvitationCreditResetInput,
) {
  return apiFetch<{ updated: number }>('/v1/admin/invitation-credits/reset', {
    method: 'POST',
    token,
    body: JSON.stringify(input),
  });
}

export function getInvitationAuditLogs(
  token: string,
  params: { limit: number; offset: number },
) {
  const query = buildQueryString(params);
  return apiFetch<InvitationAuditLogsPage>(
    `/v1/admin/invitation-audit-logs${query}`,
    { token },
  );
}
