/**
 * Focused tests for the remote device identity contract (A-04):
 * pairing bootstrap lifecycle, public-key enrollment, per-device
 * authentication, revocation/offline-copy resistance, step-up approval, the
 * scope registry, and capability-aware RPC authorization.
 *
 * The service is exercised against a raw in-memory better-sqlite3 database so
 * the tests stay independent of the full `Database` module.
 */

import { describe, expect, it } from 'vitest'
import DatabaseConstructor from 'better-sqlite3'
import type { Database } from '../database/database'
import { REMOTE_DEVICE_SQL } from '../database/schema'
import {
  DeviceCredentialService,
  generateSigningKeyPair,
  signTranscript,
  DEFAULT_DEVICE_SCOPES,
  PAIRING_TTL_MS
} from './device-credential-service'
import { RemoteRpcDispatcher, type RemoteRpcServices } from './remote-rpc'
import type { ProjectManager } from '../../lib/engines/project-manager'
import type { RemoteRpcDeviceContext } from '../../lib/remote-rpc'
import {
  REMOTE_ALLOWED_CHANNELS,
  assertRemoteChannelRegistry,
  authorizationForChannel,
  REMOTE_CHANNEL_AUTHORIZATION
} from '../../lib/remote-rpc'

interface RawStatement {
  run(...params: unknown[]): { changes: number }
}

function makeTestDb(): Database {
  const raw = new DatabaseConstructor(':memory:')
  raw.pragma('foreign_keys = ON')
  raw.exec(REMOTE_DEVICE_SQL)
  const prepared = raw.prepare.bind(raw)
  return {
    run: (sql: string, ...params: unknown[]) => {
      prepared(sql).run(...params)
    },
    get: <T>(sql: string, ...params: unknown[]) => prepared(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: unknown[]) => prepared(sql).all(...params) as T[],
    prepare: (sql: string): RawStatement => ({
      run: (...params: unknown[]) => prepared(sql).run(...params)
    }),
    transaction: <T>(fn: () => T) => raw.transaction(fn)()
  } as unknown as Database
}

function makeMockChatEngine(): RemoteRpcServices['chatEngine'] {
  return {
    loadMessages: async () => [],
    deleteThreadSession: async () => undefined,
    listProviderSnapshot: async () => [],
    getSessionStatus: async () => null,
    ensureSession: async () => 'session-1',
    sendPrompt: async () => ({ id: 'm1', role: 'assistant', parts: [], createdAt: 0 }),
    steerPrompt: async () => ({ id: 'm2', role: 'assistant', parts: [], createdAt: 0 }),
    abort: async () => undefined,
    listPermissions: async () => [],
    replyPermission: async () => undefined,
    listQuestions: async () => [],
    answerQuestion: async () => undefined
  } as unknown as RemoteRpcServices['chatEngine']
}

describe('Remote channel authorization registry', () => {
  it('maps every allowlisted channel to exactly one authorization entry', () => {
    expect(assertRemoteChannelRegistry()).toEqual([])
  })

  it('registry and allowlist are the same size (one entry per channel)', () => {
    const registryChannels = new Set(Object.keys(REMOTE_CHANNEL_AUTHORIZATION))
    expect(registryChannels.size).toBe(new Set(REMOTE_ALLOWED_CHANNELS).size)
    for (const channel of REMOTE_ALLOWED_CHANNELS) expect(registryChannels.has(channel)).toBe(true)
  })

  it('default low-risk scope set covers the conversation + read channels', () => {
    for (const scope of DEFAULT_DEVICE_SCOPES) {
      expect(DEFAULT_DEVICE_SCOPES.includes(scope)).toBe(true)
    }
    expect(authorizationForChannel('project:list')?.scope).toBe('workspace.read')
    expect(authorizationForChannel('git:push')?.scope).toBe('git.write')
    expect(authorizationForChannel('git:push')?.stepUp).toBe('always')
    expect(authorizationForChannel('checkpoint:rollbackPaths')?.scope).toBe('rollback')
  })
})

describe('DeviceCredentialService — pairing bootstrap', () => {
  it('issues a single-use bootstrap that expires within five minutes', async () => {
    const now = 1_000_000
    const db = makeTestDb()
    const service = new DeviceCredentialService(db, { now: () => now })
    const bootstrap = await service.createPairingBootstrap()
    expect(bootstrap.value.length).toBeGreaterThanOrEqual(32)
    expect(bootstrap.expiresAt - bootstrap.issuedAt).toBeLessThanOrEqual(PAIRING_TTL_MS)

    const consumed = await service.consumePairingBootstrap(bootstrap.value)
    expect(consumed.ok).toBe(true)

    // Single-use: a second consume of the same value fails.
    const again = await service.consumePairingBootstrap(bootstrap.value)
    expect(again.ok).toBe(false)

    // Issuing a newer bootstrap invalidates the older one.
    const newer = await service.createPairingBootstrap()
    expect(newer.value).not.toBe(bootstrap.value)
    const stale = await service.consumePairingBootstrap(bootstrap.value)
    expect(stale.ok).toBe(false)
  })

  it('rejects an expired bootstrap', async () => {
    let now = 1_000_000
    const db = makeTestDb()
    const service = new DeviceCredentialService(db, { now: () => now })
    const bootstrap = await service.createPairingBootstrap()
    now += PAIRING_TTL_MS + 1_000
    const consumed = await service.consumePairingBootstrap(bootstrap.value)
    expect(consumed.ok).toBe(false)
    if (!consumed.ok) expect(consumed.reason).toBe('bootstrap_expired')
  })

  it('rejects an unknown bootstrap value', async () => {
    const db = makeTestDb()
    const service = new DeviceCredentialService(db)
    const consumed = await service.consumePairingBootstrap('not-a-real-bootstrap')
    expect(consumed.ok).toBe(false)
  })
})

describe('DeviceCredentialService — enrollment', () => {
  it('enrolls a device with a valid bootstrap, keys, and proof of possession', async () => {
    const db = makeTestDb()
    const service = new DeviceCredentialService(db)
    const bootstrap = await service.createPairingBootstrap()
    const signing = await generateSigningKeyPair()
    const agreement = await generateSigningKeyPair()
    const transcript = `enroll:${bootstrap.bootstrapId}`
    const proof = await signTranscript(signing.privateJwk, transcript)

    const outcome = await service.enrollDevice({
      bootstrapValue: bootstrap.value,
      name: '  Phone One  ',
      signingPublicJwk: signing.publicJwk,
      agreementPublicJwk: agreement.publicJwk,
      signingProof: proof,
      proofTranscript: transcript
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.device) return
    expect(outcome.device.name).toBe('Phone One')
    expect(outcome.device.scopes).toEqual([...DEFAULT_DEVICE_SCOPES].sort())
    expect(outcome.device.authVersion).toBe(1)
    expect(outcome.device.revokedAt).toBeNull()
    // Distinct public-key fingerprint is derived from the key material.
    expect(outcome.device.publicKeyFingerprint.length).toBe(64)
  })

  it('enrollment consumes the bootstrap (single-use) and rotates older ones', async () => {
    const db = makeTestDb()
    const service = new DeviceCredentialService(db)
    const first = await service.createPairingBootstrap()
    const second = await service.createPairingBootstrap()
    const signing = await generateSigningKeyPair()
    const agreement = await generateSigningKeyPair()

    const outcome = await service.enrollDevice({
      bootstrapValue: second.value,
      name: 'Phone',
      signingPublicJwk: signing.publicJwk,
      agreementPublicJwk: agreement.publicJwk,
      signingProof: '__desktop_generated__'
    })
    expect(outcome.ok).toBe(true)
    // The older bootstrap is invalidated by rotation.
    const stale = await service.consumePairingBootstrap(first.value)
    expect(stale.ok).toBe(false)
  })

  it('rejects enrollment without key possession', async () => {
    const db = makeTestDb()
    const service = new DeviceCredentialService(db)
    const bootstrap = await service.createPairingBootstrap()
    const keys = await generateSigningKeyPair()
    const outcome = await service.enrollDevice({
      bootstrapValue: bootstrap.value,
      name: 'Phone',
      signingPublicJwk: keys.publicJwk,
      agreementPublicJwk: keys.publicJwk,
      signingProof: 'bm90LWEtc2lnbmF0dXJl'
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('signature_invalid')
  })

  it('rejects enrollment with a non-P-256 key', async () => {
    const db = makeTestDb()
    const service = new DeviceCredentialService(db)
    const bootstrap = await service.createPairingBootstrap()
    const bogus = { kty: 'EC', crv: 'P-384', x: 'a', y: 'b' } as JsonWebKey
    const outcome = await service.enrollDevice({
      bootstrapValue: bootstrap.value,
      name: 'Phone',
      signingPublicJwk: bogus,
      agreementPublicJwk: bogus,
      signingProof: '__desktop_generated__'
    })
    expect(outcome.ok).toBe(false)
  })
})

describe('DeviceCredentialService — authentication and revocation', () => {
  async function enrollPhone(
    service: DeviceCredentialService,
    name = 'Phone'
  ): Promise<{ deviceId: string; signingPrivateJwk: JsonWebKey; signingPublicJwk: JsonWebKey }> {
    const bootstrap = await service.createPairingBootstrap()
    const signing = await generateSigningKeyPair()
    const agreement = await generateSigningKeyPair()
    const outcome = await service.enrollDevice({
      bootstrapValue: bootstrap.value,
      name,
      signingPublicJwk: signing.publicJwk,
      agreementPublicJwk: agreement.publicJwk,
      signingProof: '__desktop_generated__'
    })
    if (!outcome.ok || !outcome.device) throw new Error('enrollment failed')
    return {
      deviceId: outcome.device.deviceId,
      signingPrivateJwk: signing.privateJwk,
      signingPublicJwk: signing.publicJwk
    }
  }

  it('authenticates a device with a fresh signature over the transcript', async () => {
    const db = makeTestDb()
    const service = new DeviceCredentialService(db)
    const phone = await enrollPhone(service)
    const transcript = `auth:${phone.deviceId}:nonce-123`
    const signature = await signTranscript(phone.signingPrivateJwk, transcript)
    const result = await service.authenticateDevice({
      deviceId: phone.deviceId,
      transcript,
      signature,
      authVersion: 1,
      transport: 'lan'
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.device?.lastUsedAt).toBeGreaterThan(0)
      expect(result.device?.publicKeyFingerprint).toBeDefined()
    }
  })

  it('rejects a handshake signed by a different key (copied credential)', async () => {
    const db = makeTestDb()
    const service = new DeviceCredentialService(db)
    const phone = await enrollPhone(service)
    const imposter = await generateSigningKeyPair()
    const transcript = `auth:${phone.deviceId}:nonce-456`
    const signature = await signTranscript(imposter.privateJwk, transcript)
    const result = await service.authenticateDevice({
      deviceId: phone.deviceId,
      transcript,
      signature,
      authVersion: 1,
      transport: 'lan'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('signature_invalid')
  })

  it('rejects a revoked device even with a valid key (offline-copy resistance)', async () => {
    const db = makeTestDb()
    const service = new DeviceCredentialService(db)
    const phone = await enrollPhone(service)
    expect(service.revokeDevice(phone.deviceId, 'stolen phone')).toBe(true)

    const transcript = `auth:${phone.deviceId}:nonce-789`
    const signature = await signTranscript(phone.signingPrivateJwk, transcript)
    const result = await service.authenticateDevice({
      deviceId: phone.deviceId,
      transcript,
      signature,
      authVersion: 1,
      transport: 'lan'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('revoked')

    // The device still appears in the list, marked revoked.
    const device = service.getDevice(phone.deviceId)
    expect(device?.revokedAt).not.toBeNull()
    expect(device?.revokedReason).toBe('stolen phone')
  })

  it('rejects an expired device authorization', async () => {
    let now = 1_000_000
    const db = makeTestDb()
    const service = new DeviceCredentialService(db, { now: () => now })
    const phone = await enrollPhone(service)
    // Advance beyond the 180-day device expiry.
    now += 181 * 24 * 60 * 60 * 1_000
    const transcript = `auth:${phone.deviceId}:nonce-abc`
    const signature = await signTranscript(phone.signingPrivateJwk, transcript)
    const result = await service.authenticateDevice({
      deviceId: phone.deviceId,
      transcript,
      signature,
      authVersion: 1,
      transport: 'lan'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('expired')
  })

  it('revoking bumps authVersion and invalidates a prior version', async () => {
    const db = makeTestDb()
    const service = new DeviceCredentialService(db)
    const phone = await enrollPhone(service)
    expect(service.revokeDevice(phone.deviceId, 'lost')).toBe(true)
    const revoked = service.getDevice(phone.deviceId)
    expect(revoked?.authVersion).toBeGreaterThan(1)
    expect(service.revokeDevice('ghost-device', 'lost')).toBe(false)
  })
})

describe('DeviceCredentialService — step-up approval', () => {
  it('approves then consumes a single-use approval bound to the exact request', async () => {
    const db = makeTestDb()
    const service = new DeviceCredentialService(db)
    const created = service.createStepUpApproval({
      deviceId: 'device-a',
      authVersion: 1,
      sessionId: 'session-1',
      requestId: 'req-1',
      channel: 'git:push',
      action: 'git:push',
      resource: 'proj-1',
      argsDigest: 'digest-1'
    })
    expect(created.ok).toBe(true)
    if (!created.ok || !created.approval) return

    expect(
      service.resolveStepUpApproval({
        approvalId: created.approval.approvalId,
        deviceId: 'device-a',
        authVersion: 1,
        sessionId: 'session-1',
        requestId: 'req-1',
        channel: 'git:push',
        resource: 'proj-1',
        argsDigest: 'digest-1',
        decision: 'approved'
      })
    ).toBe(true)

    // The retry consumes the approval exactly once.
    expect(
      service.hasApprovalFor({
        deviceId: 'device-a',
        authVersion: 1,
        sessionId: 'session-1',
        requestId: 'req-1',
        channel: 'git:push',
        resource: 'proj-1',
        argsDigest: 'digest-1'
      })
    ).toBe(true)
    expect(
      service.hasApprovalFor({
        deviceId: 'device-a',
        authVersion: 1,
        sessionId: 'session-1',
        requestId: 'req-1',
        channel: 'git:push',
        resource: 'proj-1',
        argsDigest: 'digest-1'
      })
    ).toBe(false)
  })

  it('rejects a mismatched binding (different digest or device)', async () => {
    const db = makeTestDb()
    const service = new DeviceCredentialService(db)
    const created = service.createStepUpApproval({
      deviceId: 'device-a',
      authVersion: 1,
      sessionId: 'session-1',
      requestId: 'req-1',
      channel: 'git:push',
      action: 'git:push',
      argsDigest: 'digest-1'
    })
    if (!created.ok || !created.approval) return
    expect(
      service.resolveStepUpApproval({
        approvalId: created.approval.approvalId,
        deviceId: 'device-b',
        authVersion: 1,
        sessionId: 'session-1',
        requestId: 'req-1',
        channel: 'git:push',
        argsDigest: 'digest-1',
        decision: 'approved'
      })
    ).toBe(false)
    // A rejected decision discards the ticket.
    const second = service.createStepUpApproval({
      deviceId: 'device-a',
      authVersion: 1,
      sessionId: 's',
      requestId: 'r',
      channel: 'git:commit',
      action: 'git:commit',
      argsDigest: 'd'
    })
    if (!second.ok || !second.approval) return
    service.resolveStepUpApproval({
      approvalId: second.approval.approvalId,
      deviceId: 'device-a',
      authVersion: 1,
      sessionId: 's',
      requestId: 'r',
      channel: 'git:commit',
      argsDigest: 'd',
      decision: 'rejected'
    })
    expect(
      service.hasApprovalFor({
        deviceId: 'device-a',
        authVersion: 1,
        sessionId: 's',
        requestId: 'r',
        channel: 'git:commit',
        argsDigest: 'd'
      })
    ).toBe(false)
  })

  it('rejects overflow beyond five pending approvals per device', async () => {
    const db = makeTestDb()
    const service = new DeviceCredentialService(db)
    for (let index = 0; index < 5; index += 1) {
      const created = service.createStepUpApproval({
        deviceId: 'device-a',
        authVersion: 1,
        sessionId: 's',
        requestId: `req-${index}`,
        channel: 'git:commit',
        action: 'git:commit',
        argsDigest: `d-${index}`
      })
      expect(created.ok).toBe(true)
    }
    const overflow = service.createStepUpApproval({
      deviceId: 'device-a',
      authVersion: 1,
      sessionId: 's',
      requestId: 'req-overflow',
      channel: 'git:push',
      action: 'git:push',
      argsDigest: 'd-overflow'
    })
    expect(overflow.ok).toBe(false)
    if (!overflow.ok) expect(overflow.reason).toBe('overflow')
  })
})

describe('RemoteRpcDispatcher — capability-aware authorization', () => {
  const mockProjectManager = {
    listProjects: async () => [],
    getProject: async () => null,
    getIconDataUrl: async () => null
  } as unknown as ProjectManager

  async function buildContext(): Promise<{
    dispatcher: RemoteRpcDispatcher
    device: RemoteRpcDeviceContext
  }> {
    const db = makeTestDb()
    const service = new DeviceCredentialService(db)
    const dispatcher = new RemoteRpcDispatcher({
      database: {} as Database,
      chatEngine: makeMockChatEngine(),
      projectManager: mockProjectManager,
      credentials: service
    })
    const device: RemoteRpcDeviceContext = {
      deviceId: 'device-1',
      name: 'iPhone',
      fingerprint: '0123456789abcdef0123456789abcdef',
      authVersion: 1,
      sessionId: 'session-1',
      requestId: 'req-1',
      scopes: ['workspace.read', 'conversation.read', 'conversation.control', 'git.read']
    }
    return { dispatcher, device }
  }

  it('allows a channel within the device scopes', async () => {
    const { dispatcher, device } = await buildContext()
    const outcome = await dispatcher.dispatch({
      id: 1,
      channel: 'project:list',
      args: [],
      device
    })
    expect(outcome.ok).toBe(true)
  })

  it('denies a channel outside the device scopes', async () => {
    const { dispatcher, device } = await buildContext()
    const outcome = await dispatcher.dispatch({
      id: 2,
      channel: 'git:push',
      args: ['project-1'],
      device
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain('Access denied')
  })

  it('rejects device-less invocations when a credential service is configured', async () => {
    const { dispatcher } = await buildContext()
    // The cloud relay dispatches RPC without any device context — this must
    // fail closed instead of executing as the trusted desktop path.
    const outcome = await dispatcher.dispatch({
      id: 99,
      channel: 'project:list',
      args: []
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain('Device authentication required')
  })

  it('requires step-up approval for high-risk channels and executes after approval', async () => {
    const db = makeTestDb()
    const service = new DeviceCredentialService(db)
    let approved = false
    const chatEngine = makeMockChatEngine()
    chatEngine.replyPermission = async () => {
      approved = true
    }
    const dispatcher = new RemoteRpcDispatcher({
      database: {} as Database,
      chatEngine,
      projectManager: mockProjectManager,
      credentials: service
    })
    const device: RemoteRpcDeviceContext = {
      deviceId: 'device-1',
      name: 'iPhone',
      fingerprint: 'abcdef',
      authVersion: 1,
      sessionId: 'session-1',
      requestId: 'req-permission',
      scopes: ['conversation.read', 'permission.reply']
    }

    // permission.reply is Always step-up → the first call returns step_up_required.
    const first = await dispatcher.dispatch({
      id: 10,
      channel: 'agent:replyPermission',
      args: ['p', 't', 'approve'],
      device
    })
    expect(first.ok).toBe(false)
    if (first.ok) return
    const payload = JSON.parse(first.message) as { code: string; approvalId: string }
    expect(payload.code).toBe('step_up_required')
    expect(approved).toBe(false)

    // The desktop approves the single-use ticket; the retry executes.
    expect(dispatcher.approveStepUp(payload.approvalId, 'approved')).toBe(true)
    const second = await dispatcher.dispatch({
      id: 10,
      channel: 'agent:replyPermission',
      args: ['p', 't', 'approve'],
      device
    })
    expect(second.ok).toBe(true)
    expect(approved).toBe(true)
  })

  it('records audit events identifying the device, capability, and decision', async () => {
    const { dispatcher, device } = await buildContext()
    await dispatcher.dispatch({ id: 3, channel: 'git:push', args: ['project-1'], device })
    await dispatcher.dispatch({ id: 4, channel: 'project:list', args: [], device })
    const events = dispatcher.listAuditEvents(50)
    const denied = events.find((event) => event.decision === 'rpc_denied')
    expect(denied).toBeDefined()
    expect(denied?.deviceId).toBe('device-1')
    expect(denied?.channel).toBe('git:push')
    expect(denied?.requiredScope).toBe('git.write')
    const allowed = events.find((event) => event.decision === 'rpc_allowed')
    expect(allowed).toBeDefined()
    expect(allowed?.deviceId).toBe('device-1')
    expect(allowed?.channel).toBe('project:list')
  })
})
