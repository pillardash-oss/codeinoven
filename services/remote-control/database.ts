import { Database } from 'bun:sqlite'
import type { AuthenticatedSession, DesktopRecord, EnrollmentRecord, UserRecord } from './types'

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
  claimed_at INTEGER
);
CREATE INDEX IF NOT EXISTS enrollments_expiry_idx ON enrollments(expires_at);

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
  }

  close(): void {
    this.db.close()
  }

  findUserByEmail(email: string): UserRecord | null {
    return (
      (this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as
        UserRecord | undefined) ?? null
    )
  }

  findUserById(id: string): UserRecord | null {
    return (
      (this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRecord | undefined) ??
      null
    )
  }

  createUser(user: UserRecord): void {
    this.db
      .prepare(
        'INSERT INTO users(id, email, display_name, password_hash, created_at) VALUES(?, ?, ?, ?, ?)'
      )
      .run(user.id, user.email, user.display_name, user.password_hash, user.created_at)
  }

  createSession(session: AuthenticatedSession, tokenHash: string): void {
    const now = Date.now()
    this.db
      .prepare(
        'INSERT INTO sessions(id, user_id, token_hash, created_at, expires_at, last_seen_at) VALUES(?, ?, ?, ?, ?, ?)'
      )
      .run(session.id, session.userId, tokenHash, now, session.expiresAt, now)
  }

  sessionByTokenHash(hash: string): AuthenticatedSession | null {
    const row = this.db
      .prepare(
        'SELECT id, user_id AS userId, expires_at AS expiresAt FROM sessions WHERE token_hash = ? AND expires_at > ?'
      )
      .get(hash, Date.now()) as AuthenticatedSession | undefined
    return row ?? null
  }

  touchSession(id: string): void {
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(Date.now(), id)
  }

  deleteSession(hash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash)
  }

  deleteExpiredSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now())
  }

  createDesktop(desktop: DesktopRecord): void {
    this.db
      .prepare(
        `INSERT INTO desktops(
          id, user_id, name, platform, token_hash, control_secret_cipher,
          created_at, last_seen_at, revoked_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        desktop.id,
        desktop.user_id,
        desktop.name,
        desktop.platform,
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

  claimDesktop(desktopId: string, userId: string): boolean {
    const result = this.db
      .prepare(
        'UPDATE desktops SET user_id = ? WHERE id = ? AND user_id IS NULL AND revoked_at IS NULL'
      )
      .run(userId, desktopId)
    return result.changes === 1
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

  createEnrollment(enrollment: EnrollmentRecord, createdAt: number): void {
    this.db
      .prepare(
        'INSERT INTO enrollments(id, desktop_id, code_hash, created_at, expires_at, claimed_at) VALUES(?, ?, ?, ?, ?, ?)'
      )
      .run(
        enrollment.id,
        enrollment.desktop_id,
        enrollment.code_hash,
        createdAt,
        enrollment.expires_at,
        enrollment.claimed_at
      )
  }

  enrollmentByCodeHash(hash: string): EnrollmentRecord | null {
    return (
      (this.db
        .prepare(
          'SELECT * FROM enrollments WHERE code_hash = ? AND expires_at > ? AND claimed_at IS NULL'
        )
        .get(hash, Date.now()) as EnrollmentRecord | undefined) ?? null
    )
  }

  enrollmentForDesktop(desktopId: string): EnrollmentRecord | null {
    return (
      (this.db.prepare('SELECT * FROM enrollments WHERE desktop_id = ?').get(desktopId) as
        EnrollmentRecord | undefined) ?? null
    )
  }

  markEnrollmentClaimed(id: string): void {
    this.db.prepare('UPDATE enrollments SET claimed_at = ? WHERE id = ?').run(Date.now(), id)
  }

  audit(kind: string, userId: string | null, desktopId: string | null): void {
    this.db
      .prepare(
        'INSERT INTO audit_events(id, user_id, desktop_id, kind, metadata_json, created_at) VALUES(?, ?, ?, ?, ?, ?)'
      )
      .run(crypto.randomUUID(), userId, desktopId, kind, '{}', Date.now())
  }
}
