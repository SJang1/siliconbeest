import { apiFetch } from '../client'

export function createReport(params: {
  account_id: string
  status_ids?: string[]
  comment?: string
  category?: 'spam' | 'violation' | 'legal' | 'other'
  forward?: boolean
  rule_ids?: number[]
}, token: string) {
  return apiFetch('/api/v1/reports', { method: 'POST', body: JSON.stringify(params), token })
}
