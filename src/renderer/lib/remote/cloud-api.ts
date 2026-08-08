import { decryptDesktopGrant, mobileGrantIdentity } from './mobile-control-key'

export interface CloudUser {
  id: string
  email: string
  displayName: string
  image: string | null
}

export interface CloudDesktop {
  id: string
  name: string
  platform: string
  online: boolean
  lastSeenAt: number | null
  createdAt: number
}

export interface CloudDesktopConnection {
  desktop: Pick<CloudDesktop, 'id' | 'name' | 'platform' | 'online'>
  controlSecret: string
  mobileDeviceId: string
  lanEndpoint: string | null
  relayPath: string
}

interface EncryptedDesktopConnection {
  desktop: Pick<CloudDesktop, 'id' | 'name' | 'platform' | 'online'>
  grant: {
    mobileDeviceId: string
    desktopPublicKey: JsonWebKey
    ciphertext: string
  }
  lanEndpoint: string | null
  relayPath: string
}

interface ApiErrorPayload {
  error?: string
}

export class CloudApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string
  ) {
    super(code)
    this.name = 'CloudApiError'
  }
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers
    }
  })
  if (!response.ok) {
    let code = 'request-failed'
    try {
      const payload = (await response.json()) as ApiErrorPayload
      code = payload.error ?? code
    } catch {
      // Keep the generic code when the error response is not JSON.
    }
    throw new CloudApiError(response.status, code)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export async function listCloudDesktops(): Promise<CloudDesktop[]> {
  const response = await apiRequest<{ desktops: CloudDesktop[] }>('/v1/desktops')
  return response.desktops
}

export async function claimCloudDesktop(code: string): Promise<string> {
  const identity = await mobileGrantIdentity()
  const response = await apiRequest<{ desktopId: string }>('/v1/device-enrollments/claim', {
    method: 'POST',
    body: JSON.stringify({
      code,
      mobileDeviceId: identity.id,
      mobileName: identity.name,
      mobilePublicKey: identity.publicKey
    })
  })
  return response.desktopId
}

export async function cloudDesktopConnection(desktopId: string): Promise<CloudDesktopConnection> {
  const identity = await mobileGrantIdentity()
  const response = await apiRequest<EncryptedDesktopConnection>(
    `/v1/desktops/${encodeURIComponent(desktopId)}/connection?mobileDeviceId=${encodeURIComponent(identity.id)}`
  )
  if (response.grant.mobileDeviceId !== identity.id) throw new Error('device-not-approved')
  return {
    desktop: response.desktop,
    controlSecret: await decryptDesktopGrant({
      desktopId,
      mobileDeviceId: identity.id,
      desktopPublicKey: response.grant.desktopPublicKey,
      ciphertext: response.grant.ciphertext
    }),
    mobileDeviceId: identity.id,
    lanEndpoint: response.lanEndpoint,
    relayPath: response.relayPath
  }
}

export async function renameCloudDesktop(desktopId: string, name: string): Promise<void> {
  await apiRequest(`/v1/desktops/${encodeURIComponent(desktopId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name })
  })
}

export async function revokeCloudDesktop(desktopId: string): Promise<void> {
  await apiRequest(`/v1/desktops/${encodeURIComponent(desktopId)}`, { method: 'DELETE' })
}
