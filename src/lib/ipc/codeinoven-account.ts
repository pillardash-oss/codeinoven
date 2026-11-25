/** The CodeInOven service account this desktop is signed in to, as Settings shows it. */
export interface CodeInOvenAccountStatus {
  apiBase: string
  signedIn: boolean
  user: { id: string; email: string; name: string | null; emailVerified: boolean } | null
  /** Epoch milliseconds of the last heartbeat the service accepted, or null. */
  lastHeartbeatAt: number | null
  /** Why the last call to the service failed, cleared by the next success. */
  error: string | null
}

export interface CodeInOvenSignInInput {
  apiBase: string
  email: string
  password: string
  /** Present when the account is being created rather than opened. */
  name?: string
}
