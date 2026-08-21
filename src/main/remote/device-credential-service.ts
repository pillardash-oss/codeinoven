/**
 * Device credential service (A-04).
 *
 * Issues and verifies per-device public-key-backed credentials after a
 * short-lived single-use pairing ceremony, and enforces the full identity
 * contract: five-minute single-use pairing bootstraps that rotate after
 * enrollment, distinct proof-of-possession keys per device, expiry and idle
 * expiry, rotation, human revocation with tombstones, in-process local step-up
 * approval, and a bounded security audit log.
 *
 * The desktop stores only public JWKs and fingerprints — never a device
 * private key. Handshake proof is an ECDSA P-256 signature over the exact
 * transcript the desktop presented, so copying a credential record, a QR
 * value, or a frame is never sufficient to authenticate.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import type { Database } from '../database/database'
import {
  RemoteDeviceRepo,
  type RemoteAuditEvent,
  type RemoteAuditReasonCode,
  type RemoteScope,
  type StoredRemoteDevice
} from '../database/repositories/remote-device-repo'

export const PAIRING_TTL_MS = 5 * 60 * 1_000
export const DEVICE_EXPIRY_MS = 180 * 24 * 60 * 60 * 1_000
export const IDLE_EXPIRY_MS = 90 * 24 * 60 * 60 * 1_000
export const CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1_000
export const ROTATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000
export const LAST_USE_WRITE_THROTTLE_MS = 15 * 60 * 1_000
export const STEP_UP_TTL_MS = 60 * 1_000
export const MAX_PENDING_APPROVALS_PER_DEVICE = 5
export const MAX_PENDING_APPROVALS_GLOBAL = 20
export const TOMBSTONE_RETENTION_MS = Math.max(
  365 * 24 * 60 * 60 * 1_000,
  DEVICE_EXPIRY_MS + 7 * 24 * 60 * 60 * 1_000
)

/** Workspace capabilities expected from the paired remote application. */
export const DEFAULT_DEVICE_SCOPES: readonly RemoteScope[] = [
  'workspace.read',
  'workspace.write',
  'workspace.delete',
  'config.read',
  'conversation.read',
  'conversation.control',
  'workflow.read',
  'git.read',
  'git.write',
  'memory.read',
  'memory.write',
  'filesystem.read'
]

export type EnrolledDevice = StoredRemoteDevice

export interface PairingBootstrap {
  value: string
  bootstrapId: string
  issuedAt: number
  expiresAt: number
}

export interface AuthenticateOutcome {
  ok: boolean
  device?: EnrolledDevice
  reason?: RemoteAuditReasonCode
}

export interface PendingStepUpApproval {
  approvalId: string
  deviceId: string
  authVersion: number
  sessionId: string
  requestId: string
  channel: string
  action: string
  resource: string | null
  argsDigest: string
  createdAt: number
  expiresAt: number
  state: 'pending' | 'approved' | 'rejected'
}

export interface StepUpApprovalInput {
  deviceId: string
  authVersion: number
  sessionId: string
  requestId: string
  channel: string
  action: string
  resource?: string | null
  argsDigest: string
  now?: number
}

export interface EnrollmentInput {
  bootstrapValue: string
  name: string
  signingPublicJwk: JsonWebKey
  agreementPublicJwk: JsonWebKey
  /** ECDSA signature over `proofTranscript`; required unless keys are desktop-generated. */
  signingProof?: string | null
  proofTranscript?: string | null
  clientNonce?: string | null
  scopes?: RemoteScope[]
  allProjects?: boolean
  projectIds?: string[]
  transport?: 'lan' | 'relay'
}

export interface EnrollOutcome {
  ok: boolean
  device?: EnrolledDevice
  reason?: RemoteAuditReasonCode
  message?: string
}

const encoder = new TextEncoder()
const P256_SIGNING_ALGO: EcKeyImportParams = { name: 'ECDSA', namedCurve: 'P-256' }
const SIGN_HASH: AlgorithmIdentifier = 'SHA-256'

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function fromBase64Url(value: string): ArrayBuffer {
  const bytes = Buffer.from(value, 'base64url')
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input))
  return Buffer.from(digest).toString('hex')
}

/** SHA-256 fingerprint of a public JWK — the stable public identifier. */
export async function fingerprintPublicKey(jwk: JsonWebKey): Promise<string> {
  return sha256Hex(JSON.stringify(jwk))
}

async function isValidP256PublicJwk(jwk: JsonWebKey): Promise<boolean> {
  if (jwk?.kty !== 'EC' || jwk.crv !== 'P-256') return false
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return false
  try {
    // Validate the EC point generically: a P-256 public point imports as ECDH
    // regardless of whether the key was created for ECDSA signing or ECDH.
    await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
    return true
  } catch {
    return false
  }
}

async function verifyEcdsaSignature(
  publicJwk: JsonWebKey,
  transcript: string,
  signatureBase64Url: string
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('jwk', publicJwk, P256_SIGNING_ALGO, false, [
      'verify'
    ])
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: SIGN_HASH },
      key,
      fromBase64Url(signatureBase64Url),
      encoder.encode(transcript)
    )
  } catch {
    return false
  }
}

/** Generate an exportable ECDSA P-256 key pair for enrollment tooling. */
export async function generateSigningKeyPair(): Promise<{
  privateJwk: JsonWebKey
  publicJwk: JsonWebKey
}> {
  const pair = await crypto.subtle.generateKey(P256_SIGNING_ALGO, true, ['sign', 'verify'])
  return {
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey)
  }
}

/** Sign a transcript with a private JWK (used by a phone keypair in tests). */
export async function signTranscript(privateJwk: JsonWebKey, transcript: string): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', privateJwk, P256_SIGNING_ALGO, false, ['sign'])
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: SIGN_HASH },
    key,
    encoder.encode(transcript)
  )
  return toBase64Url(new Uint8Array(signature))
}

export class DeviceCredentialService {
  private readonly repo: RemoteDeviceRepo
  private readonly now: () => number
  private readonly pendingApprovals = new Map<string, PendingStepUpApproval>()
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null

  constructor(db: Database, options: { now?: () => number } = {}) {
    this.repo = new RemoteDeviceRepo(db)
    this.now = options.now ?? (() => Date.now())
    this.upgradeLegacyWorkspaceScopes()
  }

  /**
   * Earlier releases enrolled the PWA with fewer scopes than its shipped UI
   * exposes. Top every active device whose scopes are a subset of the current
   * default profile up to that profile, preserving authVersion so an already
   * paired phone does not get signed out. Devices with custom grants outside
   * the default set are left untouched.
   */
  private upgradeLegacyWorkspaceScopes(): void {
    const defaults = new Set<RemoteScope>(DEFAULT_DEVICE_SCOPES)
    for (const device of this.repo.listActive()) {
      const current = new Set<RemoteScope>(device.scopes)
      if (current.size === defaults.size) continue
      if (![...current].every((scope) => defaults.has(scope))) continue
      this.repo.updateScopes(device.deviceId, [...DEFAULT_DEVICE_SCOPES], device.authVersion)
    }
  }

  // ── Periodic maintenance ─────────────────────────────────────────────

  /** Prune tombstone rows older than the retention window. */
  pruneTombstones(): void {
    this.repo.pruneTombstones(this.now(), TOMBSTONE_RETENTION_MS)
  }

  /**
   * Schedule bounded-growth maintenance (audit log cap + age, tombstone
   * retention) on a fire-and-forget interval. The timer is `unref()`'d so it
   * never holds the app open, making an explicit `stop()` optional.
   */
  startPeriodicMaintenance(intervalMs = 6 * 60 * 60 * 1_000): void {
    if (this.maintenanceTimer) return
    const run = (): void => {
      try {
        this.pruneAudit()
        this.pruneTombstones()
      } catch {
        // Best-effort: a failed prune must never take the remote stack down.
      }
    }
    run()
    this.maintenanceTimer = setInterval(run, intervalMs)
    this.maintenanceTimer.unref?.()
  }

  /** Stop the periodic maintenance timer (no-op when not started). */
  stopPeriodicMaintenance(): void {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer)
      this.maintenanceTimer = null
    }
  }

  // ── Pairing bootstrap lifecycle ───────────────────────────────────────

  /**
   * Issue a single-use pairing bootstrap. The raw value is returned for the QR
   * URL fragment; only its SHA-256 hash is persisted. Issuing a new bootstrap
   * invalidates every older unused one (rotation on refresh).
   */
  async createPairingBootstrap(): Promise<PairingBootstrap> {
    const now = this.now()
    this.repo.invalidateBootstraps()
    const value = randomBytes(32).toString('base64url')
    const bootstrap: PairingBootstrap = {
      value,
      bootstrapId: randomUUID(),
      issuedAt: now,
      expiresAt: now + PAIRING_TTL_MS
    }
    this.repo.insertBootstrap({
      bootstrapId: bootstrap.bootstrapId,
      hash: await sha256Hex(value),
      issuedAt: bootstrap.issuedAt,
      expiresAt: bootstrap.expiresAt,
      state: 'pending'
    })
    this.audit({
      decision: 'pairing_issued',
      deviceId: null,
      transport: null,
      resourceId: bootstrap.bootstrapId
    })
    return bootstrap
  }

  /**
   * Validate a presented bootstrap value: constant-time hash match, pending
   * state, and expiry. Rotation is single-use: the first consumer atomically
   * moves it to `consuming`; anything after that fails.
   */
  async consumePairingBootstrap(
    value: string
  ): Promise<{ ok: boolean; bootstrapId?: string; reason?: RemoteAuditReasonCode }> {
    if (typeof value !== 'string' || value.length === 0) {
      return { ok: false, reason: 'bootstrap_missing' }
    }
    const hash = await sha256Hex(value)
    // Resolve the bootstrap record by matching the stored hash.
    const record = this.repo.getBootstrapByHash(hash)
    if (!record) {
      this.audit({ decision: 'pairing_consumed', reasonCode: 'bootstrap_missing', deviceId: null })
      return { ok: false, reason: 'bootstrap_missing' }
    }
    if (record.state !== 'pending') {
      this.audit({
        decision: 'pairing_consumed',
        reasonCode: 'bootstrap_used',
        deviceId: null,
        resourceId: record.bootstrapId
      })
      return { ok: false, reason: 'bootstrap_used' }
    }
    if (record.expiresAt <= this.now()) {
      this.repo.markBootstrapState(record.bootstrapId, 'expired')
      this.audit({
        decision: 'pairing_expired',
        reasonCode: 'bootstrap_expired',
        deviceId: null,
        resourceId: record.bootstrapId
      })
      return { ok: false, reason: 'bootstrap_expired' }
    }
    // Single-use: only the first valid consumer can move pending → consuming.
    if (!this.repo.consumeBootstrap(record.bootstrapId, 'consuming')) {
      this.audit({
        decision: 'pairing_consumed',
        reasonCode: 'bootstrap_used',
        deviceId: null,
        resourceId: record.bootstrapId
      })
      return { ok: false, reason: 'bootstrap_used' }
    }
    this.audit({
      decision: 'pairing_consumed',
      deviceId: null,
      resourceId: record.bootstrapId
    })
    return { ok: true, bootstrapId: record.bootstrapId }
  }

  /** Rotate pairing: invalidate every unused bootstrap after enrollment. */
  invalidatePairing(): void {
    this.repo.invalidateBootstraps()
  }

  /**
   * Register the gateway's current pairing value as a bootstrap so enrollment
   * can consume it in constant time without ever storing the raw value. Any
   * older unused bootstrap is invalidated (rotation on refresh).
   */
  async registerPairingValue(
    value: string,
    options: { issuedAt?: number; expiresAt?: number } = {}
  ): Promise<{ bootstrapId: string; issuedAt: number; expiresAt: number }> {
    const now = options.issuedAt ?? this.now()
    this.repo.invalidateBootstraps()
    const record = {
      bootstrapId: randomUUID(),
      hash: await sha256Hex(value),
      issuedAt: now,
      expiresAt: options.expiresAt ?? now + PAIRING_TTL_MS,
      state: 'pending' as const
    }
    this.repo.insertBootstrap(record)
    this.audit({
      decision: 'pairing_issued',
      deviceId: null,
      transport: null,
      resourceId: record.bootstrapId
    })
    return record
  }

  // ── Enrollment ────────────────────────────────────────────────────────

  /**
   * Enroll a device after a validated bootstrap. Creates a distinct device
   * record with the default low-risk scopes, issues a signed credential, and
   * marks the bootstrap used. Proof-of-possession over the exact transcript
   * is mandatory: the device must sign with the key it is submitting, so no
   * bearer-style or server-generated enrollment is possible.
   */
  async enrollDevice(input: EnrollmentInput): Promise<EnrollOutcome> {
    const consumed = await this.consumePairingBootstrap(input.bootstrapValue)
    if (!consumed.ok) return { ok: false, reason: consumed.reason }

    const name = input.name.trim().slice(0, 100) || 'Phone'
    if (
      !(await isValidP256PublicJwk(input.signingPublicJwk)) ||
      !(await isValidP256PublicJwk(input.agreementPublicJwk))
    ) {
      this.audit({
        decision: 'enrolled',
        reasonCode: 'malformed',
        deviceId: null,
        deviceName: name
      })
      return { ok: false, reason: 'malformed' }
    }

    const transcript =
      input.proofTranscript ?? `${consumed.bootstrapId}:${input.clientNonce ?? 'none'}`
    const verified = await verifyEcdsaSignature(
      input.signingPublicJwk,
      transcript,
      input.signingProof ?? ''
    )
    if (!verified) {
      this.audit({
        decision: 'enrolled',
        reasonCode: 'signature_invalid',
        deviceId: null,
        deviceName: name
      })
      return { ok: false, reason: 'signature_invalid' }
    }

    const now = this.now()
    const device: StoredRemoteDevice = {
      deviceId: randomUUID(),
      name,
      signingPublicJwk: input.signingPublicJwk,
      agreementPublicJwk: input.agreementPublicJwk,
      publicKeyFingerprint: await fingerprintPublicKey(input.signingPublicJwk),
      scopes: [...new Set(input.scopes ?? DEFAULT_DEVICE_SCOPES)].sort(),
      allProjects: input.allProjects ?? true,
      projectIds: input.projectIds ?? [],
      authVersion: 1,
      credentialIssuedAt: now,
      credentialExpiresAt: now + CREDENTIAL_TTL_MS,
      createdAt: now,
      lastUsedAt: null,
      expiresAt: now + DEVICE_EXPIRY_MS,
      rotatedAt: null,
      revokedAt: null,
      revokedReason: null,
      lastTransport: input.transport ?? 'lan'
    }
    this.repo.upsert(device)
    this.repo.markBootstrapState(consumed.bootstrapId ?? '', 'used')
    this.invalidatePairing()
    this.audit({
      decision: 'enrolled',
      deviceId: device.deviceId,
      deviceName: device.name,
      fingerprintPrefix: device.publicKeyFingerprint.slice(0, 8),
      transport: device.lastTransport,
      authVersion: device.authVersion
    })
    return { ok: true, device: device as EnrolledDevice }
  }

  // ── Authentication ────────────────────────────────────────────────────

  /**
   * Authenticate a device handshake. Loads the exact device record, rejects
   * revoked/expired/idle-expired/superseded records, and requires a fresh
   * ECDSA signature over the transcript signed with the device's key.
   */
  async authenticateDevice(input: {
    deviceId: string
    transcript: string
    signature: string
    authVersion: number
    transport: 'lan' | 'relay'
  }): Promise<AuthenticateOutcome> {
    const device = this.repo.get(input.deviceId)
    if (!device) {
      if (this.repo.tombstoneExists(input.deviceId)) {
        this.audit({
          decision: 'auth_revoked',
          reasonCode: 'revoked',
          deviceId: input.deviceId,
          transport: input.transport
        })
        return { ok: false, reason: 'revoked' }
      }
      this.audit({
        decision: 'auth_failed',
        reasonCode: 'missing_record',
        deviceId: input.deviceId,
        transport: input.transport
      })
      return { ok: false, reason: 'missing_record' }
    }
    if (device.revokedAt !== null) {
      this.audit({
        decision: 'auth_revoked',
        reasonCode: 'revoked',
        deviceId: device.deviceId,
        deviceName: device.name,
        fingerprintPrefix: device.publicKeyFingerprint.slice(0, 8),
        transport: input.transport,
        authVersion: device.authVersion
      })
      return { ok: false, reason: 'revoked' }
    }
    const now = this.now()
    if (device.expiresAt <= now) {
      this.audit({
        decision: 'auth_failed',
        reasonCode: 'expired',
        deviceId: device.deviceId,
        deviceName: device.name,
        transport: input.transport,
        authVersion: device.authVersion
      })
      return { ok: false, reason: 'expired' }
    }
    if (device.lastUsedAt !== null && device.lastUsedAt + IDLE_EXPIRY_MS <= now) {
      this.audit({
        decision: 'auth_failed',
        reasonCode: 'idle_expired',
        deviceId: device.deviceId,
        deviceName: device.name,
        transport: input.transport,
        authVersion: device.authVersion
      })
      return { ok: false, reason: 'idle_expired' }
    }
    if (device.authVersion !== input.authVersion) {
      this.audit({
        decision: 'auth_failed',
        reasonCode: 'superseded_auth_version',
        deviceId: device.deviceId,
        deviceName: device.name,
        transport: input.transport,
        authVersion: device.authVersion
      })
      return { ok: false, reason: 'superseded_auth_version' }
    }
    const verified = await verifyEcdsaSignature(
      device.signingPublicJwk,
      input.transcript,
      input.signature
    )
    if (!verified) {
      this.audit({
        decision: 'auth_failed',
        reasonCode: 'signature_invalid',
        deviceId: device.deviceId,
        deviceName: device.name,
        fingerprintPrefix: device.publicKeyFingerprint.slice(0, 8),
        transport: input.transport,
        authVersion: device.authVersion
      })
      return { ok: false, reason: 'signature_invalid' }
    }
    // Persist last-use at most once per throttle window.
    if (device.lastUsedAt === null || device.lastUsedAt + LAST_USE_WRITE_THROTTLE_MS < now) {
      device.lastUsedAt = now
      this.repo.touchLastUsed(device.deviceId, now, input.transport)
    }
    this.audit({
      decision: 'auth_success',
      deviceId: device.deviceId,
      deviceName: device.name,
      fingerprintPrefix: device.publicKeyFingerprint.slice(0, 8),
      transport: input.transport,
      authVersion: device.authVersion
    })
    return { ok: true, device: device as EnrolledDevice }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Whether the enrolled device record is currently valid for a given
   * authVersion. Consulted on every high-level authorization so revocation,
   * expiry, idle expiry, and key/scope rotation take effect immediately —
   * a bound session is never trusted statelessly.
   */
  isDeviceActive(deviceId: string, authVersion: number): boolean {
    const device = this.repo.get(deviceId)
    if (!device) return false
    if (device.revokedAt !== null) return false
    const now = this.now()
    if (device.expiresAt <= now) return false
    if (device.lastUsedAt !== null && device.lastUsedAt + IDLE_EXPIRY_MS <= now) return false
    if (device.authVersion !== authVersion) return false
    return true
  }

  listDevices(): EnrolledDevice[] {
    return this.repo.list() as EnrolledDevice[]
  }

  listActiveDevices(): EnrolledDevice[] {
    return this.repo.listActive() as EnrolledDevice[]
  }

  getDevice(deviceId: string): EnrolledDevice | null {
    return (this.repo.get(deviceId) as EnrolledDevice | null) ?? null
  }

  /** Human revocation: bumps authVersion, writes a tombstone, prunes approvals. */
  revokeDevice(deviceId: string, reason: string): boolean {
    const device = this.repo.get(deviceId)
    if (!device) return false
    const at = this.now()
    this.repo.revoke(device, reason.trim().slice(0, 200) || 'operator', at)
    for (const [approvalId, approval] of this.pendingApprovals) {
      if (approval.deviceId === deviceId) this.pendingApprovals.delete(approvalId)
    }
    this.audit({
      decision: 'revoked',
      deviceId: device.deviceId,
      deviceName: device.name,
      fingerprintPrefix: device.publicKeyFingerprint.slice(0, 8),
      reasonCode: null,
      authVersion: device.authVersion + 1
    })
    return true
  }

  renameDevice(deviceId: string, name: string): boolean {
    const trimmed = name.trim().slice(0, 100)
    if (trimmed.length === 0) return false
    const device = this.repo.get(deviceId)
    if (!device) return false
    this.repo.updateName(deviceId, trimmed)
    this.audit({
      decision: 'auth_success',
      deviceId,
      deviceName: trimmed,
      authVersion: device.authVersion
    })
    return true
  }

  /** Change a device's scopes; bumps authVersion so live sessions terminate. */
  updateScopes(deviceId: string, scopes: RemoteScope[]): boolean {
    const device = this.repo.get(deviceId)
    if (!device) return false
    const next = [...new Set(scopes)].sort()
    const nextVersion = device.authVersion + 1
    this.repo.updateScopes(deviceId, next, nextVersion)
    this.audit({
      decision: 'scope_change',
      deviceId,
      deviceName: device.name,
      requiredScope: next.join(','),
      authVersion: nextVersion
    })
    return true
  }

  /** Rotate a device's keys; requires proof by both the old and new keys. */
  async rotateCredentials(input: {
    deviceId: string
    newSigningPublicJwk: JsonWebKey
    newAgreementPublicJwk: JsonWebKey
    oldProof: string
    newProof: string
    proofTranscript: string
  }): Promise<EnrollOutcome> {
    const device = this.repo.get(input.deviceId)
    if (!device || device.revokedAt !== null) return { ok: false, reason: 'missing_record' }
    if (
      !(await isValidP256PublicJwk(input.newSigningPublicJwk)) ||
      !(await isValidP256PublicJwk(input.newAgreementPublicJwk))
    ) {
      return { ok: false, reason: 'malformed' }
    }
    const oldVerified = await verifyEcdsaSignature(
      device.signingPublicJwk,
      input.proofTranscript,
      input.oldProof
    )
    const newVerified = await verifyEcdsaSignature(
      input.newSigningPublicJwk,
      input.proofTranscript,
      input.newProof
    )
    if (!oldVerified || !newVerified) {
      this.audit({
        decision: 'rotation',
        reasonCode: 'signature_invalid',
        deviceId: device.deviceId,
        deviceName: device.name,
        authVersion: device.authVersion
      })
      return { ok: false, reason: 'signature_invalid' }
    }
    const now = this.now()
    const next: StoredRemoteDevice = {
      ...device,
      signingPublicJwk: input.newSigningPublicJwk,
      agreementPublicJwk: input.newAgreementPublicJwk,
      publicKeyFingerprint: await fingerprintPublicKey(input.newSigningPublicJwk),
      authVersion: device.authVersion + 1,
      credentialIssuedAt: now,
      credentialExpiresAt: now + CREDENTIAL_TTL_MS,
      rotatedAt: now
    }
    this.repo.rotateCredentials(next)
    this.audit({
      decision: 'rotation',
      deviceId: next.deviceId,
      deviceName: next.name,
      fingerprintPrefix: next.publicKeyFingerprint.slice(0, 8),
      authVersion: next.authVersion
    })
    return { ok: true, device: next as EnrolledDevice }
  }

  /** Local renewal: extends device authorization without extending credential lifetime. */
  renewDevice(deviceId: string): EnrollOutcome {
    const device = this.repo.get(deviceId)
    if (!device || device.revokedAt !== null) return { ok: false, reason: 'missing_record' }
    const now = this.now()
    const next: StoredRemoteDevice = {
      ...device,
      authVersion: device.authVersion + 1,
      credentialIssuedAt: now,
      credentialExpiresAt: now + CREDENTIAL_TTL_MS,
      expiresAt: now + DEVICE_EXPIRY_MS
    }
    this.repo.rotateCredentials(next)
    this.audit({
      decision: 'renewal',
      deviceId: next.deviceId,
      deviceName: next.name,
      authVersion: next.authVersion
    })
    return { ok: true, device: next as EnrolledDevice }
  }

  // ── Local step-up approval ────────────────────────────────────────────

  /**
   * Create a single-use local approval bound to a device, session, request,
   * channel, resource, and argument digest. Overflow rejects and is audited.
   */
  createStepUpApproval(input: StepUpApprovalInput): {
    ok: boolean
    approval?: PendingStepUpApproval
    reason?: 'overflow'
  } {
    const now = input.now ?? this.now()
    const perDevice = [...this.pendingApprovals.values()].filter(
      (approval) => approval.deviceId === input.deviceId
    ).length
    if (
      perDevice >= MAX_PENDING_APPROVALS_PER_DEVICE ||
      this.pendingApprovals.size >= MAX_PENDING_APPROVALS_GLOBAL
    ) {
      this.audit({
        decision: 'step_up_required',
        reasonCode: 'overflow',
        deviceId: input.deviceId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        channel: input.channel,
        resourceId: input.resource ?? null,
        authVersion: input.authVersion
      })
      return { ok: false, reason: 'overflow' }
    }
    const approval: PendingStepUpApproval = {
      approvalId: randomUUID(),
      deviceId: input.deviceId,
      authVersion: input.authVersion,
      sessionId: input.sessionId,
      requestId: input.requestId,
      channel: input.channel,
      action: input.action,
      resource: input.resource ?? null,
      argsDigest: input.argsDigest,
      createdAt: now,
      expiresAt: now + STEP_UP_TTL_MS,
      state: 'pending'
    }
    this.pendingApprovals.set(approval.approvalId, approval)
    this.audit({
      decision: 'step_up_required',
      deviceId: input.deviceId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      channel: input.channel,
      resourceId: input.resource ?? null,
      stepUpApprovalId: approval.approvalId,
      authVersion: input.authVersion
    })
    return { ok: true, approval }
  }

  /**
   * Resolve a pending approval with a trusted desktop decision. Binding is
   * exact: the caller must re-present the device, session, request, channel,
   * resource, and digest. An approved ticket remains available for the single
   * matching retry; a rejected ticket is discarded.
   */
  resolveStepUpApproval(input: {
    approvalId: string
    deviceId: string
    authVersion: number
    sessionId: string
    requestId: string
    channel: string
    resource?: string | null
    argsDigest: string
    decision: 'approved' | 'rejected'
  }): boolean {
    const approval = this.pendingApprovals.get(input.approvalId)
    if (!approval) return false
    if (approval.expiresAt <= this.now()) {
      this.pendingApprovals.delete(input.approvalId)
      this.audit({
        decision: 'step_up_timeout',
        stepUpApprovalId: input.approvalId,
        deviceId: input.deviceId,
        channel: input.channel,
        authVersion: input.authVersion
      })
      return false
    }
    const matches =
      approval.deviceId === input.deviceId &&
      approval.authVersion === input.authVersion &&
      approval.sessionId === input.sessionId &&
      approval.requestId === input.requestId &&
      approval.channel === input.channel &&
      approval.argsDigest === input.argsDigest &&
      (input.resource ?? null) === approval.resource
    if (!matches) {
      this.audit({
        decision: input.decision === 'approved' ? 'step_up_approved' : 'step_up_rejected',
        reasonCode: 'approval_mismatch',
        stepUpApprovalId: input.approvalId,
        deviceId: input.deviceId,
        channel: input.channel,
        authVersion: input.authVersion
      })
      return false
    }
    if (input.decision === 'rejected') {
      this.pendingApprovals.delete(input.approvalId)
    } else {
      approval.state = 'approved'
    }
    this.audit({
      decision: input.decision === 'approved' ? 'step_up_approved' : 'step_up_rejected',
      stepUpApprovalId: input.approvalId,
      deviceId: input.deviceId,
      deviceName: this.repo.get(input.deviceId)?.name ?? null,
      sessionId: input.sessionId,
      requestId: input.requestId,
      channel: input.channel,
      resourceId: input.resource ?? null,
      authVersion: input.authVersion
    })
    return true
  }

  /**
   * A valid, unexpired *approved* ticket for a request (consumes on success).
   * Returns the consumed approval id, or null when no ticket matched.
   */
  hasApprovalFor(input: {
    deviceId: string
    authVersion: number
    sessionId: string
    requestId: string
    channel: string
    resource?: string | null
    argsDigest: string
  }): string | null {
    const now = this.now()
    for (const approval of this.pendingApprovals.values()) {
      if (approval.expiresAt <= now) {
        this.pendingApprovals.delete(approval.approvalId)
        continue
      }
      if (
        approval.state === 'approved' &&
        approval.deviceId === input.deviceId &&
        approval.authVersion === input.authVersion &&
        approval.sessionId === input.sessionId &&
        approval.requestId === input.requestId &&
        approval.channel === input.channel &&
        approval.argsDigest === input.argsDigest &&
        (input.resource ?? null) === approval.resource
      ) {
        this.pendingApprovals.delete(approval.approvalId)
        return approval.approvalId
      }
    }
    return null
  }

  listPendingApprovals(): PendingStepUpApproval[] {
    const now = this.now()
    for (const [id, approval] of this.pendingApprovals) {
      if (approval.expiresAt <= now) this.pendingApprovals.delete(id)
    }
    return [...this.pendingApprovals.values()]
  }

  // ── Audit ─────────────────────────────────────────────────────────────

  audit(
    event: Partial<Omit<RemoteAuditEvent, 'id'>> & {
      decision: RemoteAuditEvent['decision']
      timestamp?: number
    }
  ): void {
    this.repo.appendAudit(event)
  }

  listAudit(limit = 100): RemoteAuditEvent[] {
    return this.repo.listAudit(limit)
  }

  pruneAudit(): number {
    return this.repo.pruneAudit(this.now())
  }
}
