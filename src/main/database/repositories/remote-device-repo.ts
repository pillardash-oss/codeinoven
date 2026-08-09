/**
 * SQLite repository for remote device identity (A-04).
 *
 * Persists per-device scoped credentials, revocation tombstones, the bounded
 * security audit log, and single-use pairing bootstraps. The repository only
 * ever stores public keys, fingerprints, and hashes — never a device private
 * key or the raw shared pairing value.
 */

import { randomUUID } from 'node:crypto'
import type { Database } from '../database'
import type { RemoteScope } from '../../../lib/remote-rpc'

/** The scope identifiers a device may be granted (section 5 of the contract). */
export type { RemoteScope }

export interface StoredRemoteDevice {
  deviceId: string
  name: string
  signingPublicJwk: JsonWebKey
  agreementPublicJwk: JsonWebKey
  publicKeyFingerprint: string
  /** Sorted, unique scope identifiers granted to the device. */
  scopes: RemoteScope[]
  /** Whether the device may reach every project (local explicit choice). */
  allProjects: boolean
  /** Project ids allowed when `allProjects` is false. */
  projectIds: string[]
  authVersion: number
  credentialIssuedAt: number
  credentialExpiresAt: number
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number
  rotatedAt: number | null
  revokedAt: number | null
  revokedReason: string | null
  lastTransport: 'lan' | 'relay'
}

export interface RemoteDeviceTombstone {
  deviceId: string
  publicKeyFingerprint: string
  lastAuthVersion: number
  revokedAt: number
}

export type RemoteAuditDecision =
  | 'pairing_issued'
  | 'pairing_consumed'
  | 'pairing_expired'
  | 'enrolled'
  | 'auth_success'
  | 'auth_failed'
  | 'auth_revoked'
  | 'auth_expired'
  | 'rotation'
  | 'renewal'
  | 'scope_change'
  | 'revoked'
  | 'rpc_allowed'
  | 'rpc_denied'
  | 'step_up_required'
  | 'step_up_approved'
  | 'step_up_rejected'
  | 'step_up_timeout'
  | 'migration'

export type RemoteAuditReasonCode =
  | 'missing_record'
  | 'revoked'
  | 'expired'
  | 'idle_expired'
  | 'superseded_auth_version'
  | 'signature_invalid'
  | 'bootstrap_expired'
  | 'bootstrap_used'
  | 'bootstrap_missing'
  | 'no_scope'
  | 'missing_approval'
  | 'approval_mismatch'
  | 'approval_replay'
  | 'mismatch'
  | 'overflow'
  | 'malformed'
  | 'denied_by_default'

export interface RemoteAuditEvent {
  id: string
  timestamp: number
  deviceId: string | null
  deviceName: string | null
  fingerprintPrefix: string | null
  transport: 'lan' | 'relay' | null
  sessionId: string | null
  requestId: string | null
  channel: string | null
  projectId: string | null
  resourceId: string | null
  requiredScope: string | null
  decision: RemoteAuditDecision
  reasonCode: RemoteAuditReasonCode | null
  stepUpApprovalId: string | null
  authVersion: number | null
}

export interface RemotePairingBootstrap {
  bootstrapId: string
  /** SHA-256 hash of the raw pairing value — never the value itself. */
  hash: string
  issuedAt: number
  expiresAt: number
  state: 'pending' | 'consuming' | 'used' | 'expired' | 'invalidated'
}

export const AUDIT_MAX_EVENTS = 10_000
export const AUDIT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000

interface DeviceRow {
  device_id: string
  name: string
  signing_public_jwk: string
  agreement_public_jwk: string
  public_key_fingerprint: string
  scopes: string
  all_projects: number
  project_ids: string
  auth_version: number
  credential_issued_at: number
  credential_expires_at: number
  created_at: number
  last_used_at: number | null
  expires_at: number
  rotated_at: number | null
  revoked_at: number | null
  revoked_reason: string | null
  last_transport: string
}

interface AuditRow {
  id: string
  timestamp: number
  device_id: string | null
  device_name: string | null
  fingerprint_prefix: string | null
  transport: string | null
  session_id: string | null
  request_id: string | null
  channel: string | null
  project_id: string | null
  resource_id: string | null
  required_scope: string | null
  decision: string
  reason_code: string | null
  step_up_approval_id: string | null
  auth_version: number | null
}

/** Safe JSON read for stored blobs — a corrupt row must never break a device list. */
function parseStoredJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function parseJwk(value: unknown): JsonWebKey | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record['kty'] !== 'string') return null
  return record as unknown as JsonWebKey
}

function rowToDevice(row: DeviceRow): StoredRemoteDevice | null {
  const signing = parseJwk(parseStoredJson(row.signing_public_jwk))
  const agreement = parseJwk(parseStoredJson(row.agreement_public_jwk))
  if (!signing || !agreement) return null
  const parsedScopes = parseStoredJson(row.scopes)
  const scopes = Array.isArray(parsedScopes)
    ? parsedScopes.filter((scope): scope is RemoteScope => typeof scope === 'string')
    : []
  const parsedProjects = parseStoredJson(row.project_ids)
  const projectIds = Array.isArray(parsedProjects)
    ? parsedProjects.filter((id): id is string => typeof id === 'string')
    : []
  return {
    deviceId: row.device_id,
    name: row.name,
    signingPublicJwk: signing,
    agreementPublicJwk: agreement,
    publicKeyFingerprint: row.public_key_fingerprint,
    scopes,
    allProjects: row.all_projects === 1,
    projectIds,
    authVersion: row.auth_version,
    credentialIssuedAt: row.credential_issued_at,
    credentialExpiresAt: row.credential_expires_at,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? null,
    expiresAt: row.expires_at,
    rotatedAt: row.rotated_at ?? null,
    revokedAt: row.revoked_at ?? null,
    revokedReason: row.revoked_reason ?? null,
    lastTransport: row.last_transport === 'relay' ? 'relay' : 'lan'
  }
}

function rowToAudit(row: AuditRow): RemoteAuditEvent {
  return {
    id: row.id,
    timestamp: row.timestamp,
    deviceId: row.device_id,
    deviceName: row.device_name,
    fingerprintPrefix: row.fingerprint_prefix,
    transport: row.transport === 'relay' ? 'relay' : row.transport === 'lan' ? 'lan' : null,
    sessionId: row.session_id,
    requestId: row.request_id,
    channel: row.channel,
    projectId: row.project_id,
    resourceId: row.resource_id,
    requiredScope: row.required_scope,
    decision: row.decision as RemoteAuditDecision,
    reasonCode: row.reason_code as RemoteAuditReasonCode | null,
    stepUpApprovalId: row.step_up_approval_id,
    authVersion: row.auth_version
  }
}

export class RemoteDeviceRepo {
  constructor(private db: Database) {}

  upsert(device: StoredRemoteDevice): void {
    this.db.run(
      `INSERT INTO remote_devices(
        device_id, name, signing_public_jwk, agreement_public_jwk,
        public_key_fingerprint, scopes, all_projects, project_ids,
        auth_version, credential_issued_at, credential_expires_at,
        created_at, last_used_at, expires_at, rotated_at,
        revoked_at, revoked_reason, last_transport
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(device_id) DO UPDATE SET
        name = excluded.name,
        signing_public_jwk = excluded.signing_public_jwk,
        agreement_public_jwk = excluded.agreement_public_jwk,
        public_key_fingerprint = excluded.public_key_fingerprint,
        scopes = excluded.scopes,
        all_projects = excluded.all_projects,
        project_ids = excluded.project_ids,
        auth_version = excluded.auth_version,
        credential_issued_at = excluded.credential_issued_at,
        credential_expires_at = excluded.credential_expires_at,
        last_used_at = excluded.last_used_at,
        expires_at = excluded.expires_at,
        rotated_at = excluded.rotated_at,
        revoked_at = excluded.revoked_at,
        revoked_reason = excluded.revoked_reason,
        last_transport = excluded.last_transport`,
      device.deviceId,
      device.name,
      JSON.stringify(device.signingPublicJwk),
      JSON.stringify(device.agreementPublicJwk),
      device.publicKeyFingerprint,
      JSON.stringify([...device.scopes].sort()),
      device.allProjects ? 1 : 0,
      JSON.stringify(device.projectIds),
      device.authVersion,
      device.credentialIssuedAt,
      device.credentialExpiresAt,
      device.createdAt,
      device.lastUsedAt ?? null,
      device.expiresAt,
      device.rotatedAt ?? null,
      device.revokedAt ?? null,
      device.revokedReason ?? null,
      device.lastTransport
    )
  }

  get(deviceId: string): StoredRemoteDevice | null {
    const row = this.db.get<DeviceRow>('SELECT * FROM remote_devices WHERE device_id = ?', deviceId)
    return row ? rowToDevice(row) : null
  }

  list(): StoredRemoteDevice[] {
    const rows = this.db.all<DeviceRow>(
      'SELECT * FROM remote_devices ORDER BY created_at DESC, device_id ASC'
    )
    return rows.map(rowToDevice).filter((device): device is StoredRemoteDevice => device !== null)
  }

  /** Active (non-revoked) devices, newest first. */
  listActive(): StoredRemoteDevice[] {
    return this.list().filter((device) => device.revokedAt === null)
  }

  updateName(deviceId: string, name: string): void {
    this.db.run('UPDATE remote_devices SET name = ? WHERE device_id = ?', name, deviceId)
  }

  updateScopes(deviceId: string, scopes: RemoteScope[], authVersion: number): void {
    this.db.run(
      'UPDATE remote_devices SET scopes = ?, auth_version = ? WHERE device_id = ?',
      JSON.stringify([...scopes].sort()),
      authVersion,
      deviceId
    )
  }

  touchLastUsed(deviceId: string, at: number, transport: 'lan' | 'relay'): void {
    this.db.run(
      'UPDATE remote_devices SET last_used_at = ?, last_transport = ? WHERE device_id = ?',
      at,
      transport,
      deviceId
    )
  }

  rotateCredentials(device: StoredRemoteDevice): void {
    this.upsert(device)
  }

  /** Revoke a device: bump authVersion, stamp revocation, and write a tombstone. */
  revoke(device: StoredRemoteDevice, reason: string, at: number): void {
    const nextVersion = device.authVersion + 1
    this.db.transaction(() => {
      this.db.run(
        `UPDATE remote_devices
         SET revoked_at = ?, revoked_reason = ?, auth_version = ?
         WHERE device_id = ?`,
        at,
        reason,
        nextVersion,
        device.deviceId
      )
      this.db.run(
        `INSERT OR REPLACE INTO remote_device_tombstones(
          device_id, public_key_fingerprint, last_auth_version, revoked_at
        ) VALUES(?,?,?,?)`,
        device.deviceId,
        device.publicKeyFingerprint,
        nextVersion,
        at
      )
    })
  }

  deleteDevice(deviceId: string): void {
    this.db.run('DELETE FROM remote_devices WHERE device_id = ?', deviceId)
  }

  tombstoneExists(deviceId: string): boolean {
    const row = this.db.get<{ cnt: number }>(
      'SELECT count(*) as cnt FROM remote_device_tombstones WHERE device_id = ?',
      deviceId
    )
    return (row?.cnt ?? 0) > 0
  }

  listTombstones(): RemoteDeviceTombstone[] {
    const rows = this.db.all<{
      device_id: string
      public_key_fingerprint: string
      last_auth_version: number
      revoked_at: number
    }>('SELECT * FROM remote_device_tombstones ORDER BY revoked_at DESC')
    return rows.map((row) => ({
      deviceId: row.device_id,
      publicKeyFingerprint: row.public_key_fingerprint,
      lastAuthVersion: row.last_auth_version,
      revokedAt: row.revoked_at
    }))
  }

  pruneTombstones(now: number, retentionMs: number): void {
    this.db.run('DELETE FROM remote_device_tombstones WHERE revoked_at < ?', now - retentionMs)
  }

  // ── Audit log ─────────────────────────────────────────────────────────

  appendAudit(
    event: Partial<Omit<RemoteAuditEvent, 'id'>> & {
      decision: RemoteAuditDecision
      timestamp?: number
    }
  ): string {
    const id = randomUUID()
    const timestamp = event.timestamp ?? Date.now()
    this.db.run(
      `INSERT INTO remote_audit_events(
        id, timestamp, device_id, device_name, fingerprint_prefix, transport,
        session_id, request_id, channel, project_id, resource_id,
        required_scope, decision, reason_code, step_up_approval_id, auth_version
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      timestamp,
      event.deviceId ?? null,
      event.deviceName ?? null,
      event.fingerprintPrefix ?? null,
      event.transport ?? null,
      event.sessionId ?? null,
      event.requestId ?? null,
      event.channel ?? null,
      event.projectId ?? null,
      event.resourceId ?? null,
      event.requiredScope ?? null,
      event.decision,
      event.reasonCode ?? null,
      event.stepUpApprovalId ?? null,
      event.authVersion ?? null
    )
    return id
  }

  listAudit(limit = 100): RemoteAuditEvent[] {
    const rows = this.db.all<AuditRow>(
      'SELECT * FROM remote_audit_events ORDER BY timestamp DESC, id DESC LIMIT ?',
      Math.max(1, Math.min(limit, AUDIT_MAX_EVENTS))
    )
    return rows.map(rowToAudit)
  }

  /** Bound the audit log to `AUDIT_MAX_EVENTS` entries and `AUDIT_MAX_AGE_MS`. */
  pruneAudit(now: number): number {
    const before =
      this.db.get<{ cnt: number }>('SELECT count(*) as cnt FROM remote_audit_events')?.cnt ?? 0
    this.db.run('DELETE FROM remote_audit_events WHERE timestamp < ?', now - AUDIT_MAX_AGE_MS)
    const excess = before - AUDIT_MAX_EVENTS
    if (excess > 0) {
      this.db.run(
        'DELETE FROM remote_audit_events WHERE id IN (SELECT id FROM remote_audit_events ORDER BY timestamp DESC LIMIT -1 OFFSET ?)',
        AUDIT_MAX_EVENTS
      )
    }
    return before
  }

  // ── Pairing bootstraps ────────────────────────────────────────────────

  insertBootstrap(record: RemotePairingBootstrap): void {
    this.db.run(
      `INSERT INTO remote_pairing_bootstraps(
        bootstrap_id, hash, issued_at, expires_at, state
      ) VALUES(?,?,?,?,?)`,
      record.bootstrapId,
      record.hash,
      record.issuedAt,
      record.expiresAt,
      record.state
    )
  }

  getBootstrap(bootstrapId: string): RemotePairingBootstrap | null {
    const row = this.db.get<{
      bootstrap_id: string
      hash: string
      issued_at: number
      expires_at: number
      state: string
    }>('SELECT * FROM remote_pairing_bootstraps WHERE bootstrap_id = ?', bootstrapId)
    if (!row) return null
    return {
      bootstrapId: row.bootstrap_id,
      hash: row.hash,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      state: row.state as RemotePairingBootstrap['state']
    }
  }

  getBootstrapByHash(hash: string): RemotePairingBootstrap | null {
    const row = this.db.get<{
      bootstrap_id: string
      hash: string
      issued_at: number
      expires_at: number
      state: string
    }>('SELECT * FROM remote_pairing_bootstraps WHERE hash = ?', hash)
    if (!row) return null
    return {
      bootstrapId: row.bootstrap_id,
      hash: row.hash,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      state: row.state as RemotePairingBootstrap['state']
    }
  }

  /** Atomically move a bootstrap to the given state if it is still `pending`. */
  consumeBootstrap(bootstrapId: string, state: 'consuming' | 'used'): boolean {
    const result = this.db
      .prepare(
        `UPDATE remote_pairing_bootstraps SET state = ? WHERE bootstrap_id = ? AND state = 'pending'`
      )
      .run(state, bootstrapId)
    return result.changes > 0
  }

  markBootstrapState(bootstrapId: string, state: RemotePairingBootstrap['state']): void {
    this.db.run(
      'UPDATE remote_pairing_bootstraps SET state = ? WHERE bootstrap_id = ?',
      state,
      bootstrapId
    )
  }

  /** Invalidate every unused bootstrap (rotation on refresh/enrollment). */
  invalidateBootstraps(): void {
    this.db.run(
      "UPDATE remote_pairing_bootstraps SET state = 'invalidated' WHERE state = 'pending'"
    )
  }
}
