export type RegistrationMode = 'open' | 'approval' | 'closed' | 'referral';
export type RegistrationDesign = 'default' | 'aurora' | 'old';

export type RegistrationState =
  | 'pending_approval'
  | 'awaiting_confirmation'
  | 'email_verification'
  | 'active';

export interface InviterSummary {
  id: string;
  username: string;
  display_name: string;
  avatar: string | null;
}

export interface InvitationPreview {
  id: string;
  inviter: InviterSummary;
  uses_remaining: number;
  expires_at: string | null;
  auto_follow: boolean;
}

export interface RegistrationRequiredResponse {
  registration_required: true;
  registration_state: RegistrationState;
}

export interface RegistrationSession {
  state: RegistrationState;
  username: string;
  email: string;
  invited_by: InviterSummary | null;
  email_verification_required: boolean;
  email_verification_expires_at: string | null;
  redirect_uri: string;
}

export interface EmailVerificationState {
  state: 'email_verification';
  email_verification_expires_at: string | null;
}

export interface RegistrationActivation {
  state: 'active';
  access_token: string;
  redirect_uri: string;
  passkey_prompt: true;
}

export interface RegistrationCompletion {
  state: 'active';
  redirect_uri: string;
  passkey_prompt: true;
}

export type RegistrationContinueResponse =
  | EmailVerificationState
  | RegistrationActivation;

export interface RegistrationCancelledResponse {
  cancelled: true;
}

export interface InvitationSummary {
  id: string;
  url: string;
  uses_remaining: number;
  issued_uses: number;
  expires_at: string | null;
  auto_follow: boolean;
  revoked_at: string | null;
  created_at: string;
}

export interface CreatedInvitation extends InvitationSummary {
  token: string;
}

export interface CreateInvitationInput {
  uses: number;
  expires_in_days: number | null;
  auto_follow: boolean;
}

export interface InvitationCredits {
  available_credits: number;
  reserved_credits: number;
  pending_refund_credits: number;
  owned_credits: number;
  max_credits: number;
  contribution_score: number;
  contribution_threshold: number;
  contribution_enabled: boolean;
  issuance_enabled: boolean;
  can_issue_links: boolean;
}

export interface AdminInvitationCreditAccount {
  account_id: string;
  username: string;
  display_name: string;
  role: string;
  available_credits: number;
  reserved_credits: number;
  pending_refund_credits: number;
  owned_credits: number;
  max_credits: number;
  contribution_score: number;
  contribution_award_level: number;
  updated_at: string | null;
}

export interface AdminInvitationCreditsPage {
  accounts: AdminInvitationCreditAccount[];
  total: number;
  limit: number;
  offset: number;
}

export type InvitationCreditOperation = 'set' | 'add' | 'contribution';

export interface InvitationCreditAdjustmentInput {
  operation: InvitationCreditOperation;
  amount: number;
  reason?: string;
}

export interface InvitationCreditBulkInput {
  account_ids?: string[];
  amount: number;
}

export interface InvitationCreditResetInput {
  account_ids?: string[];
  confirmation: 'RESET';
}

export interface InvitationAuditLog {
  id: string;
  action: string;
  actor_account_id: string | null;
  actor_username: string | null;
  target_account_id: string | null;
  target_username: string | null;
  invitation_id: string | null;
  credit_delta: number | null;
  contribution_delta: number | null;
  reason: string | null;
  created_at: string;
}

export interface InvitationAuditLogsPage {
  logs: InvitationAuditLog[];
  total: number;
  limit: number;
  offset: number;
}

export const CONTRIBUTION_EVENTS = [
  'status_create',
  'reply_create',
  'status_delete',
  'status_reblog',
  'status_unreblog',
  'status_favourite',
  'status_unfavourite',
  'account_follow',
  'account_unfollow',
  'poll_vote',
  'media_upload',
  'status_bookmark',
  'status_unbookmark',
  'profile_update',
  'report_submit',
  'list_create',
  'list_delete',
  'generic_mutation',
] as const;

export type ContributionEvent = (typeof CONTRIBUTION_EVENTS)[number];

export type ContributionPointSettings = {
  [Event in ContributionEvent as `invite_contribution_points_${Event}`]: string;
};

export interface InvitationAdminSettings extends ContributionPointSettings {
  invite_credit_max_per_account: string;
  invite_link_issuance_enabled: string;
  invite_contribution_enabled: string;
  invite_contribution_threshold: string;
}

export function createDefaultInvitationAdminSettings(): InvitationAdminSettings {
  return {
    invite_credit_max_per_account: '999',
    invite_link_issuance_enabled: '1',
    invite_contribution_enabled: '0',
    invite_contribution_threshold: '100',
    invite_contribution_points_status_create: '0',
    invite_contribution_points_reply_create: '0',
    invite_contribution_points_status_delete: '0',
    invite_contribution_points_status_reblog: '0',
    invite_contribution_points_status_unreblog: '0',
    invite_contribution_points_status_favourite: '0',
    invite_contribution_points_status_unfavourite: '0',
    invite_contribution_points_account_follow: '0',
    invite_contribution_points_account_unfollow: '0',
    invite_contribution_points_poll_vote: '0',
    invite_contribution_points_media_upload: '0',
    invite_contribution_points_status_bookmark: '0',
    invite_contribution_points_status_unbookmark: '0',
    invite_contribution_points_profile_update: '0',
    invite_contribution_points_report_submit: '0',
    invite_contribution_points_list_create: '0',
    invite_contribution_points_list_delete: '0',
    invite_contribution_points_generic_mutation: '0',
  };
}

export interface RegistrationFormData {
  username: string;
  email: string;
  password: string;
  locale: string;
  agreement: boolean;
  reason?: string;
  turnstile_token?: string;
}

export function isRegistrationRequiredResponse(
  response: RegistrationRequiredResponse | { access_token?: string },
): response is RegistrationRequiredResponse {
  return 'registration_required' in response && response.registration_required === true;
}
