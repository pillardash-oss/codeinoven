import { describe, expect, test } from 'bun:test'
import { RemoteControlDatabase } from './database'
import type { DesktopRecord, EnrollmentRecord } from './types'

function desktop(id: string, profileTokenHash: string): DesktopRecord {
  return {
    id,
    user_id: null,
    name: 'MacBook Pro',
    platform: 'darwin',
    lan_endpoint: null,
    token_hash: `device-${id}`,
    profile_token_hash: profileTokenHash,
    control_secret_cipher: '',
    created_at: 1,
    last_seen_at: null,
    revoked_at: null
  }
}

function enrollment(id: string, desktopId: string, codeHash: string): EnrollmentRecord {
  return {
    id,
    desktop_id: desktopId,
    code_hash: codeHash,
    expires_at: Date.now() + 60_000,
    claimed_at: null,
    mobile_device_id: null,
    mobile_public_key: null,
    grant_ciphertext: null,
    desktop_public_key: null
  }
}

describe('desktop enrollment replacement', () => {
  test('replaces the profile hash and enrollment atomically', () => {
    const database = new RemoteControlDatabase(':memory:')
    database.createDesktop(desktop('desktop-a', 'profile-a'))
    database.createEnrollment(enrollment('old', 'desktop-a', 'old-code'), 1)

    expect(
      database.replaceDesktopEnrollment({
        desktopId: 'desktop-a',
        profileTokenHash: 'profile-b',
        enrollment: enrollment('new', 'desktop-a', 'new-code'),
        createdAt: 2
      })
    ).toBe(true)
    expect(database.findDesktop('desktop-a')?.profile_token_hash).toBe('profile-b')
    expect(database.enrollmentForDesktop('desktop-a')?.id).toBe('new')
    database.close()
  })

  test('preserves the existing code when a profile hash collides', () => {
    const database = new RemoteControlDatabase(':memory:')
    database.createDesktop(desktop('desktop-a', 'profile-a'))
    database.createDesktop(desktop('desktop-b', 'profile-b'))
    database.createEnrollment(enrollment('old', 'desktop-a', 'old-code'), 1)

    expect(() =>
      database.replaceDesktopEnrollment({
        desktopId: 'desktop-a',
        profileTokenHash: 'profile-b',
        enrollment: enrollment('new', 'desktop-a', 'new-code'),
        createdAt: 2
      })
    ).toThrow()
    expect(database.findDesktop('desktop-a')?.profile_token_hash).toBe('profile-a')
    expect(database.enrollmentForDesktop('desktop-a')?.id).toBe('old')
    database.close()
  })
})
