import { apiFetch, type ApiResponse } from '../client'

export interface MfaSetupResponse {
  secret: string
  uri: string
  backup_codes: string[]
}

export async function mfaSetup(token: string): Promise<ApiResponse<MfaSetupResponse>> {
  return apiFetch<MfaSetupResponse>('/v1/auth/mfa/setup', {
    method: 'POST',
    token,
  })
}

export async function mfaConfirm(token: string, code: string): Promise<ApiResponse<{ success: boolean }>> {
  return apiFetch<{ success: boolean }>('/v1/auth/mfa/confirm', {
    method: 'POST',
    token,
    body: { code },
  })
}

export async function mfaDisable(token: string, password: string): Promise<ApiResponse<{ success: boolean }>> {
  return apiFetch<{ success: boolean }>('/v1/auth/mfa/disable', {
    method: 'POST',
    token,
    body: { password },
  })
}
