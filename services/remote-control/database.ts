/// <reference types="bun" />

import { Database } from 'bun:sqlite'
import type {
  AuthenticatedSession,
  DesktopRecord,
  EnrollmentRecord,
  MobileDeviceRecord,
  UserRecord
} from './types'

export type AuditEventKind =
  | 'desktop.enrollment-created'
  | 'desktop.claimed'
  | 'desktop.control-grant-created'
  | 'desktop.revoked'
  | 'desktop.renamed'
  | 'desktop.revoked-by-device'
  | 'relay.desktop-connected'
  | 'relay.desktop-disconnected'

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS account_entitlements (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free' CHECK(plan IN ('free', 'pro')),
  valid_until INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  desktop_id TEXT REFERENCES desktops(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_user_idx ON audit_events(user_id, created_at DESC);
`

export class RemoteControlDatabase {
  private readonly db: Database

  constructor(path: string) {
    this.db = new Database(path)
    this.db.exec(SCHEMA)
    this.ensureLanEndpointColumn()
    this.ensureEnrollmentGrantColumns()
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

  upsertOAuthUser(input: { id: string; email: string; displayName: string }): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO users(id, email, display_name, password_hash, created_at)
         VALUES(?, ?, ?, 'oauth:github', ?)
         ON CONFLICT(id) DO UPDATE SET
           email = excluded.email,
           display_name = excluded.display_name`
      )
      .run(input.id, input.email, input.displayName, now)
    this.db
      .prepare(
        `INSERT INTO account_entitlements(user_id, plan, valid_until, updated_at)
         VALUES(?, 'free', NULL, ?)
         ON CONFLICT(user_id) DO NOTHING`
      )
      .run(input.id, now)
  }

  entitlementForUser(userId: string): { plan: 'free' | 'pro'; validUntil: number | null } {
    const row = this.db
      .prepare('SELECT plan, valid_until FROM account_entitlements WHERE user_id = ?')
      .get(userId) as { plan: 'free' | 'pro'; valid_until: number | null } | undefined
    return { plan: row?.plan ?? 'free', validUntil: row?.valid_until ?? null }
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
      .run(session.id, session.userId, `better-auth:${session.id}`, now, session.expiresAt, now)
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
          id, user_id, name, platform, lan_endpoint, token_hash, control_secret_cipher,
          created_at, last_seen_at, revoked_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        desktop.id,
        desktop.user_id,
        desktop.name,
        desktop.platform,
        desktop.lan_endpoint,
        desktop.token_hash,
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

  touchDesktop(id: string): void {
    this.db.prepare('UPDATE desktops SET last_seen_at = ? WHERE id = ?').run(Date.now(), id)
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

  deleteEnrollmentForDesktop(desktopId: string): void {
    this.db.prepare('DELETE FROM enrollments WHERE desktop_id = ?').run(desktopId)
  }

  createEnrollment(enrollment: EnrollmentRecord, createdAt: number): void {
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
  }): { desktopId: string } | null {
    const claim = this.db.transaction((claimInput: typeof input) => {
      const now = Date.now()
      const enrollment = this.db
        .prepare(
          `SELECT e.id, e.desktop_id, d.user_id
           FROM enrollments e
           JOIN desktops d ON d.id = e.desktop_id
           WHERE e.code_hash = ? AND e.expires_at > ? AND e.claimed_at IS NULL
             AND d.revoked_at IS NULL`
        )
        .get(claimInput.codeHash, now) as
        { id: string; desktop_id: string; user_id: string | null } | undefined
      if (!enrollment || (enrollment.user_id && enrollment.user_id !== claimInput.userId)) {
        return null
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
      if (desktopClaimed.changes !== 1) throw new Error('Desktop enrollment ownership changed')

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

      return { desktopId: enrollment.desktop_id }
    })

    return claim.immediate(input)
  }

  saveDesktopGrant(
    desktopId: string,
    mobileDeviceId: string,
    desktopPublicKey: string,
    grantCiphertext: string
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE enrollments SET desktop_public_key = ?, grant_ciphertext = ?
           WHERE desktop_id = ? AND mobile_device_id = ? AND claimed_at IS NOT NULL`
        )
        .run(desktopPublicKey, grantCiphertext, desktopId, mobileDeviceId).changes === 1
    )
  }

  enrollmentGrant(
    desktopId: string,
    userId: string,
    mobileDeviceId: string
  ): EnrollmentRecord | null {
    return (
      (this.db
        .prepare(
          `SELECT e.* FROM enrollments e
           JOIN desktops d ON d.id = e.desktop_id
           JOIN mobile_devices m ON m.id = e.mobile_device_id
           WHERE e.desktop_id = ? AND d.user_id = ? AND e.mobile_device_id = ?
             AND d.revoked_at IS NULL AND m.revoked_at IS NULL`
        )
        .get(desktopId, userId, mobileDeviceId) as EnrollmentRecord | undefined) ?? null
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

  private ensureLanEndpointColumn(): void {
    const columns = this.db.query<{ name: string }, []>('PRAGMA table_info(desktops)').all()
    if (!columns.some((column) => column.name === 'lan_endpoint')) {
      this.db.exec('ALTER TABLE desktops ADD COLUMN lan_endpoint TEXT')
    }
  }

  private ensureEnrollmentGrantColumns(): void {
    const columns = this.db.query<{ name: string }, []>('PRAGMA table_info(enrollments)').all()
    const names = new Set(columns.map((column) => column.name))
    const additions = [
      ['mobile_device_id', 'TEXT'],
      ['mobile_public_key', 'TEXT'],
      ['grant_ciphertext', 'TEXT'],
      ['desktop_public_key', 'TEXT']
    ] as const
    for (const [name, type] of additions) {
      if (!names.has(name)) this.db.exec(`ALTER TABLE enrollments ADD COLUMN ${name} ${type}`)
    }
  }
}
