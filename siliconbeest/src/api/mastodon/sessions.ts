import { apiFetch, type ApiResponse } from '../client'

export interface Session {
  id: string
  application_name: string
  ip: string | null
  user_agent: string | null
  scopes: string
  created_at: string
  last_used_at: string | null
  current: boolean
}

export async function listSessions(token: string): Promise<ApiResponse<Session[]>> {
  return apiFetch<Session[]>('/v1/auth/sessions', { token })
}

export async function revokeSession(token: string, sessionId: string): Promise<ApiResponse<{ success: boolean }>> {
  return apiFetch<{ success: boolean }>(`/v1/auth/sessions/${sessionId}`, {
    method: 'DELETE',
    token,
  })
}

export async function revokeAllOtherSessions(token: string): Promise<ApiResponse<{ revoked: number }>> {
  return apiFetch<{ revoked: number }>('/v1/auth/sessions/revoke_all', {
    method: 'POST',
    token,
  })
}
