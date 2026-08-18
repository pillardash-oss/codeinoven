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

describe('OAuth identity resolution', () => {
  test('keeps one stable user id when the same email arrives under another provider id', () => {
    const database = new RemoteControlDatabase(':memory:')
    expect(
      database.upsertOAuthUser({
        id: 'original-user',
        email: 'person@example.com',
        displayName: 'Original Name',
        image: null
      })
    ).toBe('original-user')

    expect(
      database.upsertOAuthUser({
        id: 'new-provider-user',
        email: 'person@example.com',
        displayName: 'Current Name',
        image: 'https://example.com/avatar.png'
      })
    ).toBe('original-user')
    expect(database.resolveOAuthUserId('new-provider-user', 'person@example.com')).toBe(
      'original-user'
    )
    expect(database.findUserById('new-provider-user')).toBeNull()
    expect(database.findUserById('original-user')?.display_name).toBe('Current Name')
    database.close()
  })
})

describe('enrollment claim diagnostics', () => {
  test('distinguishes a wrong account from a missing code', () => {
    const database = new RemoteControlDatabase(':memory:')
    database.upsertOAuthUser({
      id: 'desktop-owner',
      email: 'owner@example.com',
      displayName: 'Owner',
      image: null
    })
    database.createDesktop({ ...desktop('desktop-a', 'profile-a'), user_id: 'desktop-owner' })
    database.createEnrollment(enrollment('pending', 'desktop-a', 'pending-code'), Date.now())

    expect(
      database.enrollmentClaimFailure({
        codeHash: 'pending-code',
        userId: 'different-user',
        mobileDeviceId: 'mobile-device-1234',
        mobilePublicKey: 'public-key'
      })
    ).toBe('account-mismatch')
    expect(
      database.enrollmentClaimFailure({
        codeHash: 'missing-code',
        userId: 'desktop-owner',
        mobileDeviceId: 'mobile-device-1234',
        mobilePublicKey: 'public-key'
      })
    ).toBe('not-found')
    database.close()
  })
})
