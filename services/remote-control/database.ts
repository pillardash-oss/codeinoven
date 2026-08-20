/// <reference types="bun" />

import { Database } from 'bun:sqlite'
import type {
  AuthenticatedSession,
  DesktopGrantRecord,
  DesktopRecord,
  EnrollmentRecord,
  MobileDeviceRecord,
  UserRecord
} from './types'

export type AuditEventKind =
  | 'desktop.enrollment-created'
  | 'desktop.enrollment-cancelled'
  | 'desktop.enrollment-conflict'
  | 'desktop.profile-synced'
  | 'desktop.claimed'
  | 'desktop.control-grant-created'
  | 'desktop.revoked'
  | 'desktop.renamed'
  | 'desktop.revoked-by-device'
  | 'relay.desktop-connected'
  | 'relay.desktop-disconnected'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  image_url TEXT,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_token_idx ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS desktops (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  lan_endpoint TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  profile_token_hash TEXT NOT NULL UNIQUE,
  control_secret_cipher TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS desktops_user_idx ON desktops(user_id, revoked_at);

CREATE TABLE IF NOT EXISTS enrollments (
  id TEXT PRIMARY KEY,
  desktop_id TEXT NOT NULL UNIQUE REFERENCES desktops(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER,
  mobile_device_id TEXT,
  mobile_public_key TEXT,
  grant_ciphertext TEXT,
  desktop_public_key TEXT
);
CREATE INDEX IF NOT EXISTS enrollments_expiry_idx ON enrollments(expires_at);

CREATE TABLE IF NOT EXISTS mobile_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS mobile_devices_user_idx ON mobile_devices(user_id, revoked_at);

CREATE TABLE IF NOT EXISTS desktop_grants (
  desktop_id TEXT NOT NULL REFERENCES desktops(id) ON DELETE CASCADE,
  mobile_device_id TEXT NOT NULL REFERENCES mobile_devices(id) ON DELETE CASCADE,
  grant_ciphertext TEXT NOT NULL,
  desktop_public_key TEXT NOT NULL,
  PRIMARY KEY(desktop_id, mobile_device_id)
);
CREATE INDEX IF NOT EXISTS desktop_grants_mobile_idx ON desktop_grants(mobile_device_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  desktop_id TEXT REFERENCES desktops(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_user_idx ON audit_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events(created_at DESC);
`

export class EnrollmentClaimConflictError extends Error {
  constructor(readonly desktopId: string) {
    super('Desktop enrollment ownership changed')
    this.name = 'EnrollmentClaimConflictError'
  }
}

export type EnrollmentClaimFailure =
  'not-found' | 'account-mismatch' | 'already-claimed' | 'mobile-device-mismatch'

export class RemoteControlDatabase {
  private readonly db: Database

  constructor(path: string) {
    this.db = new Database(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -16384;
      PRAGMA mmap_size = 134217728;
      PRAGMA wal_autocheckpoint = 1000;
      PRAGMA journal_size_limit = 33554432;
    `)
    this.db.transaction(() => this.db.exec(SCHEMA))()
    this.migrateEnrollmentGrants()
    this.ensureUserImageColumn()
    this.ensureDesktopProfileTokenColumn()
    this.db.exec('PRAGMA optimize = 0x10002;')
  }

  private migrateEnrollmentGrants(): void {
    this.db.exec(`
      INSERT OR IGNORE INTO desktop_grants(
        desktop_id, mobile_device_id, grant_ciphertext, desktop_public_key
      )
      SELECT desktop_id, mobile_device_id, grant_ciphertext, desktop_public_key
      FROM enrollments
      WHERE mobile_device_id IS NOT NULL
        AND grant_ciphertext IS NOT NULL
        AND desktop_public_key IS NOT NULL
    `)
  }

  private ensureUserImageColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'image_url')) {
      this.db.exec('ALTER TABLE users ADD COLUMN image_url TEXT')
    }
  }

  private ensureDesktopProfileTokenColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(desktops)').all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'profile_token_hash')) {
      this.db.exec('ALTER TABLE desktops ADD COLUMN profile_token_hash TEXT')
      this.db.exec('UPDATE desktops SET profile_token_hash = lower(hex(randomblob(32)))')
    }
    this.db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS desktops_profile_token_idx ON desktops(profile_token_hash)'
    )
  }

  close(): void {
    this.db.close()
  }

  findUserById(id: string): UserRecord | null {
    return (
      (this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRecord | undefined) ??
      null
    )
  }

  resolveOAuthUserId(id: string, email: string): string | null {
    const existing = this.db
      .prepare('SELECT id FROM users WHERE email = ? OR id = ? ORDER BY email = ? DESC LIMIT 1')
      .get(email, id, email) as { id: string } | undefined
    return existing?.id ?? null
  }

  upsertOAuthUser(input: {
    id: string
    email: string
    displayName: string
    image: string | null
  }): string {
    const upsert = this.db.transaction((upsertInput: typeof input) => {
      const canonical = this.db
        .prepare('SELECT id FROM users WHERE email = ? LIMIT 1')
        .get(upsertInput.email) as { id: string } | undefined
      if (canonical && canonical.id !== upsertInput.id) {
        this.db
          .prepare('UPDATE users SET display_name = ?, image_url = ? WHERE id = ?')
          .run(upsertInput.displayName, upsertInput.image, canonical.id)
        return canonical.id
      }
      this.insertOrUpdateOAuthUser(upsertInput)
      return upsertInput.id
    })
    return upsert.immediate(input)
  }

  private insertOrUpdateOAuthUser(input: {
    id: string
    email: string
    displayName: string
    image: string | null
  }): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO users(id, email, display_name, image_url, password_hash, created_at)
         VALUES(?, ?, ?, ?, 'oauth:social', ?)
         ON CONFLICT(id) DO UPDATE SET
           email = excluded.email,
           display_name = excluded.display_name,
           image_url = excluded.image_url`
      )
      .run(input.id, input.email, input.displayName, input.image, now)
  }

  rememberOAuthSession(session: AuthenticatedSession): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO sessions(id, user_id, token_hash, created_at, expires_at, last_seen_at)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           expires_at = excluded.expires_at,
           last_seen_at = excluded.last_seen_at`
      )
      .run(session.id, session.userId, `relay:${session.id}`, now, session.expiresAt, now)
  }

  activeSessionById(id: string): AuthenticatedSession | null {
    const row = this.db
      .prepare(
        'SELECT id, user_id AS userId, expires_at AS expiresAt FROM sessions WHERE id = ? AND expires_at > ?'
      )
      .get(id, Date.now()) as AuthenticatedSession | undefined
    return row ?? null
  }

  deleteExpiredSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now())
  }

  expiredSessionIds(): string[] {
    return this.db
      .prepare('SELECT id FROM sessions WHERE expires_at <= ?')
      .all(Date.now())
      .map((row) => (row as { id: string }).id)
  }

  createDesktop(desktop: DesktopRecord): void {
    this.db
      .prepare(
        `INSERT INTO desktops(
          id, user_id, name, platform, lan_endpoint, token_hash, profile_token_hash,
          control_secret_cipher, created_at, last_seen_at, revoked_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        desktop.id,
        desktop.user_id,
        desktop.name,
        desktop.platform,
        desktop.lan_endpoint,
        desktop.token_hash,
        desktop.profile_token_hash,
        desktop.control_secret_cipher,
        desktop.created_at,
        desktop.last_seen_at,
        desktop.revoked_at
      )
  }

  findDesktop(id: string): DesktopRecord | null {
    return (
      (this.db.prepare('SELECT * FROM desktops WHERE id = ?').get(id) as
        DesktopRecord | undefined) ?? null
    )
  }

  findDesktopByTokenHash(hash: string): DesktopRecord | null {
    return (
      (this.db
        .prepare('SELECT * FROM desktops WHERE token_hash = ? AND revoked_at IS NULL')
        .get(hash) as DesktopRecord | undefined) ?? null
    )
  }

  listDesktops(userId: string): DesktopRecord[] {
    return this.db
      .prepare(
        'SELECT * FROM desktops WHERE user_id = ? AND revoked_at IS NULL ORDER BY name COLLATE NOCASE'
      )
      .all(userId) as DesktopRecord[]
  }

  listDesktopsForMobile(userId: string, mobileDeviceId: string): DesktopRecord[] {
    return this.db
      .prepare(
        `SELECT d.* FROM desktops d
         JOIN desktop_grants g ON g.desktop_id = d.id
         JOIN mobile_devices m ON m.id = g.mobile_device_id
         WHERE d.user_id = ? AND g.mobile_device_id = ?
           AND d.revoked_at IS NULL AND m.revoked_at IS NULL
         ORDER BY d.name COLLATE NOCASE`
      )
      .all(userId, mobileDeviceId) as DesktopRecord[]
  }

  touchDesktop(id: string): void {
    this.db.prepare('UPDATE desktops SET last_seen_at = ? WHERE id = ?').run(Date.now(), id)
  }

  updateDesktopLanEndpoints(id: string, serializedEndpoints: string | null): void {
    this.db
      .prepare('UPDATE desktops SET lan_endpoint = ? WHERE id = ? AND revoked_at IS NULL')
      .run(serializedEndpoints, id)
  }

  renameDesktop(id: string, userId: string, name: string): boolean {
    return (
      this.db
        .prepare('UPDATE desktops SET name = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
        .run(name, id, userId).changes === 1
    )
  }

  revokeDesktop(id: string, userId: string): boolean {
    return (
      this.db
        .prepare(
          'UPDATE desktops SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL'
        )
        .run(Date.now(), id, userId).changes === 1
    )
  }

  revokeDesktopByTokenHash(hash: string): DesktopRecord | null {
    const desktop = this.findDesktopByTokenHash(hash)
    if (!desktop) return null
    this.db.prepare('UPDATE desktops SET revoked_at = ? WHERE id = ?').run(Date.now(), desktop.id)
    return desktop
  }

  createEnrollment(enrollment: EnrollmentRecord, createdAt: number): void {
    this.insertEnrollment(enrollment, createdAt)
  }

  replaceDesktopEnrollment(input: {
    desktopId: string
    profileTokenHash: string
    enrollment: EnrollmentRecord
    createdAt: number
  }): boolean {
    const replace = this.db.transaction((replaceInput: typeof input) => {
      const rotated = this.db
        .prepare('UPDATE desktops SET profile_token_hash = ? WHERE id = ? AND revoked_at IS NULL')
        .run(replaceInput.profileTokenHash, replaceInput.desktopId)
      if (rotated.changes !== 1) return false
      this.db.prepare('DELETE FROM enrollments WHERE desktop_id = ?').run(replaceInput.desktopId)
      this.insertEnrollment(replaceInput.enrollment, replaceInput.createdAt)
      return true
    })
    return replace.immediate(input)
  }

  private insertEnrollment(enrollment: EnrollmentRecord, createdAt: number): void {
    this.db
      .prepare(
        `INSERT INTO enrollments(
          id, desktop_id, code_hash, created_at, expires_at, claimed_at,
          mobile_device_id, mobile_public_key, grant_ciphertext, desktop_public_key
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        enrollment.id,
        enrollment.desktop_id,
        enrollment.code_hash,
        createdAt,
        enrollment.expires_at,
        enrollment.claimed_at,
        enrollment.mobile_device_id,
        enrollment.mobile_public_key,
        enrollment.grant_ciphertext,
        enrollment.desktop_public_key
      )
  }

  enrollmentForDesktop(desktopId: string): EnrollmentRecord | null {
    return (
      (this.db.prepare('SELECT * FROM enrollments WHERE desktop_id = ?').get(desktopId) as
        EnrollmentRecord | undefined) ?? null
    )
  }

  cancelDesktopEnrollment(desktopId: string): boolean {
    return (
      this.db.prepare('DELETE FROM enrollments WHERE desktop_id = ?').run(desktopId).changes > 0
    )
  }

  findMobileDevice(id: string): MobileDeviceRecord | null {
    return (
      (this.db.prepare('SELECT * FROM mobile_devices WHERE id = ?').get(id) as
        MobileDeviceRecord | undefined) ?? null
    )
  }

  /**
   * Atomically consume one enrollment code, bind its desktop to the account,
   * and register the claiming mobile device. BEGIN IMMEDIATE takes SQLite's
   * single-writer reservation before the eligibility read, so two requests
   * can never both observe and consume the same one-time code.
   */
  claimEnrollment(input: {
    codeHash: string
    userId: string
    mobileDeviceId: string
    mobileName: string
    mobilePublicKey: string
  }): { desktopId: string; newlyClaimed: boolean } | null {
    const claim = this.db.transaction((claimInput: typeof input) => {
      const now = Date.now()
      const enrollment = this.db
        .prepare(
          `SELECT e.id, e.desktop_id, e.claimed_at, e.mobile_device_id,
                  e.mobile_public_key, d.user_id
           FROM enrollments e
           JOIN desktops d ON d.id = e.desktop_id
           WHERE e.code_hash = ? AND e.expires_at > ? AND d.revoked_at IS NULL`
        )
        .get(claimInput.codeHash, now) as
        | {
            id: string
            desktop_id: string
            claimed_at: number | null
            mobile_device_id: string | null
            mobile_public_key: string | null
            user_id: string | null
          }
        | undefined
      if (!enrollment || (enrollment.user_id && enrollment.user_id !== claimInput.userId)) {
        return null
      }

      if (enrollment.claimed_at !== null) {
        return enrollment.mobile_device_id === claimInput.mobileDeviceId &&
          enrollment.mobile_public_key === claimInput.mobilePublicKey
          ? { desktopId: enrollment.desktop_id, newlyClaimed: false }
          : null
      }

      const existingDevice = this.findMobileDevice(claimInput.mobileDeviceId)
      if (existingDevice && existingDevice.user_id !== claimInput.userId) return null

      const consumed = this.db
        .prepare(
          `UPDATE enrollments
           SET claimed_at = ?, mobile_device_id = ?, mobile_public_key = ?
           WHERE id = ? AND claimed_at IS NULL AND expires_at > ?`
        )
        .run(now, claimInput.mobileDeviceId, claimInput.mobilePublicKey, enrollment.id, now)
      if (consumed.changes !== 1) return null

      const desktopClaimed = this.db
        .prepare(
          `UPDATE desktops SET user_id = ?
           WHERE id = ? AND revoked_at IS NULL AND (user_id IS NULL OR user_id = ?)`
        )
        .run(claimInput.userId, enrollment.desktop_id, claimInput.userId)
      if (desktopClaimed.changes !== 1) {
        throw new EnrollmentClaimConflictError(enrollment.desktop_id)
      }

      this.db
        .prepare(
          `INSERT INTO mobile_devices(id, user_id, name, public_key, created_at, last_seen_at, revoked_at)
           VALUES(?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             public_key = excluded.public_key,
             last_seen_at = excluded.last_seen_at,
             revoked_at = NULL
           WHERE mobile_devices.user_id = excluded.user_id`
        )
        .run(
          claimInput.mobileDeviceId,
          claimInput.userId,
          claimInput.mobileName,
          claimInput.mobilePublicKey,
          now,
          now
        )

      return { desktopId: enrollment.desktop_id, newlyClaimed: true }
    })

    return claim.immediate(input)
  }

  enrollmentClaimFailure(input: {
    codeHash: string
    userId: string
    mobileDeviceId: string
    mobilePublicKey: string
  }): EnrollmentClaimFailure {
    const enrollment = this.db
      .prepare(
        `SELECT e.claimed_at, e.mobile_device_id, e.mobile_public_key, d.user_id
         FROM enrollments e
         JOIN desktops d ON d.id = e.desktop_id
         WHERE e.code_hash = ? AND e.expires_at > ? AND d.revoked_at IS NULL`
      )
      .get(input.codeHash, Date.now()) as
      | {
          claimed_at: number | null
          mobile_device_id: string | null
          mobile_public_key: string | null
          user_id: string | null
        }
      | undefined
    if (!enrollment) return 'not-found'
    if (enrollment.user_id && enrollment.user_id !== input.userId) return 'account-mismatch'
    if (enrollment.claimed_at !== null) return 'already-claimed'
    const mobileDevice = this.findMobileDevice(input.mobileDeviceId)
    if (mobileDevice && mobileDevice.user_id !== input.userId) return 'mobile-device-mismatch'
    return 'not-found'
  }

  saveDesktopGrant(
    desktopId: string,
    mobileDeviceId: string,
    desktopPublicKey: string,
    grantCiphertext: string
  ): boolean {
    const save = this.db.transaction(() => {
      const enrollmentUpdated = this.db
        .prepare(
          `UPDATE enrollments SET desktop_public_key = ?, grant_ciphertext = ?
           WHERE desktop_id = ? AND mobile_device_id = ? AND claimed_at IS NOT NULL`
        )
        .run(desktopPublicKey, grantCiphertext, desktopId, mobileDeviceId).changes
      if (enrollmentUpdated !== 1) return false
      this.db
        .prepare(
          `INSERT INTO desktop_grants(
             desktop_id, mobile_device_id, desktop_public_key, grant_ciphertext
           ) VALUES(?, ?, ?, ?)
           ON CONFLICT(desktop_id, mobile_device_id) DO UPDATE SET
             desktop_public_key = excluded.desktop_public_key,
             grant_ciphertext = excluded.grant_ciphertext`
        )
        .run(desktopId, mobileDeviceId, desktopPublicKey, grantCiphertext)
      return true
    })
    return save.immediate()
  }

  enrollmentGrant(
    desktopId: string,
    userId: string,
    mobileDeviceId: string
  ): DesktopGrantRecord | null {
    return (
      (this.db
        .prepare(
          `SELECT g.* FROM desktop_grants g
           JOIN desktops d ON d.id = g.desktop_id
           JOIN mobile_devices m ON m.id = g.mobile_device_id
           WHERE g.desktop_id = ? AND d.user_id = ? AND g.mobile_device_id = ?
             AND d.revoked_at IS NULL AND m.revoked_at IS NULL`
        )
        .get(desktopId, userId, mobileDeviceId) as DesktopGrantRecord | undefined) ?? null
    )
  }

  deleteExpiredEnrollments(): void {
    const now = Date.now()
    this.db.prepare('DELETE FROM enrollments WHERE expires_at <= ? AND claimed_at IS NULL').run(now)
    this.db
      .prepare(
        `DELETE FROM desktops
         WHERE user_id IS NULL AND revoked_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.desktop_id = desktops.id)`
      )
      .run()
  }

  audit(kind: AuditEventKind, userId: string | null, desktopId: string | null): void {
    this.db
      .prepare(
        'INSERT INTO audit_events(id, user_id, desktop_id, kind, metadata_json, created_at) VALUES(?, ?, ?, ?, ?, ?)'
      )
      .run(crypto.randomUUID(), userId, desktopId, kind, '{}', Date.now())
  }

  /** Bound the audit log to 90 days and a fixed row cap. */
  pruneAudit(now: number, maxEvents = 10_000, maxAgeMs = 90 * 24 * 60 * 60 * 1_000): void {
    this.db.prepare('DELETE FROM audit_events WHERE created_at < ?').run(now - maxAgeMs)
    const count =
      this.db.query<{ cnt: number }, []>('SELECT count(*) AS cnt FROM audit_events').get()?.cnt ?? 0
    if (count > maxEvents) {
      this.db
        .prepare(
          'DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events ORDER BY created_at DESC LIMIT -1 OFFSET ?)'
        )
        .run(maxEvents)
    }
  }
}
