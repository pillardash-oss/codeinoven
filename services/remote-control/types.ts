export type RelayRole = 'desktop' | 'mobile'

export interface RelaySocketData {
  authenticated: boolean
  role: RelayRole | null
  desktopId: string | null
  userId: string | null
  connectedAt: number
}

export interface AuthenticatedSession {
  id: string
  userId: string
  expiresAt: number
}

export interface DesktopRecord {
  id: string
  user_id: string | null
  name: string
  platform: string
  token_hash: string
  control_secret_cipher: string
  created_at: number
  last_seen_at: number | null
  revoked_at: number | null
}

export interface UserRecord {
  id: string
  email: string
  display_name: string
  password_hash: string
  created_at: number
}

export interface EnrollmentRecord {
  id: string
  desktop_id: string
  code_hash: string
  expires_at: number
  claimed_at: number | null
}
