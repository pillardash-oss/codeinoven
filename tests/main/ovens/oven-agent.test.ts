import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  decodeOvenAgentDescriptor,
  encodeOvenAgentDescriptor,
  validateOvenAgentDescriptor
} from '../../../src/main/ovens/oven-agent-descriptor'
import {
  AGENT_DESCRIPTOR_PROGRAM,
  AGENT_VERIFY_PROGRAM,
  buildOvenAgentScript,
  normalizeServiceBundle
} from '../../../src/main/ovens/oven-agent-script'
import { fingerprint } from '../../../src/main/ovens/oven-agent-service'
import type { OvenAgentDescriptor } from '../../../src/lib/ovens'

const scratch = mkdtempSync(join(process.cwd(), '.cio/tmp/oven-agent-test-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const BUNDLE = normalizeServiceBundle('export const marker = "oven-service"\n')
const REVISION = createHash('sha256').update(BUNDLE).digest('hex')

/** Structurally valid test-only key material; never used to authenticate anywhere. */
const PRIVATE_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQyNTUx',
  'OQAAACB0aGlzLWlzLWEtdGVzdC1vbmx5LWtleS1ibG9iLTAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw',
  'MAAAABtj',
  '-----END OPENSSH PRIVATE KEY-----',
  ''
].join('\n')
const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINTestOnlyKeyBlobForUnitTests0000 test@oven'

function descriptor(overrides: Partial<OvenAgentDescriptor> = {}): OvenAgentDescriptor {
  return {
    kind: 'codeinoven-oven-agent',
    version: 1,
    protocolVersion: 1,
    serviceRevision: REVISION,
    platform: 'linux',
    architecture: 'x64',
    hostname: 'build-box',
    user: 'deploy',
    port: 22,
    name: 'build-box',
    dataRoot: '/home/deploy/.config/pillardash/codeinoven-oven',
    nodeVersion: '22.13.1',
    createdAt: 1_700_000_000_000,
    ...overrides
  }
}

describe('oven agent descriptor codec', () => {
  it('round-trips a descriptor through a registration code', () => {
    const source = descriptor({
      identity: { algorithm: 'ed25519', privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY }
    })
    const code = encodeOvenAgentDescriptor(source)
    expect(code.startsWith('codeinoven-oven-agent-v1:')).toBe(true)
    expect(code).not.toContain('\n')
    expect(decodeOvenAgentDescriptor(code)).toEqual(source)
  })

  it('reads the code out of the surrounding terminal output the agent prints', () => {
    const code = encodeOvenAgentDescriptor(descriptor())
    const pasted = `The Oven is ready. Paste this:\n\n${code}\n\nA copy is saved on the machine.`
    expect(decodeOvenAgentDescriptor(pasted).hostname).toBe('build-box')
  })

  it('accepts the raw saved descriptor JSON', () => {
    expect(decodeOvenAgentDescriptor(JSON.stringify(descriptor())).user).toBe('deploy')
  })

  it('rejects a foreign kind, a future version and a bad port', () => {
    expect(() => validateOvenAgentDescriptor({ ...descriptor(), kind: 'other' })).toThrow()
    expect(() => validateOvenAgentDescriptor({ ...descriptor(), version: 2 })).toThrow()
    expect(() => validateOvenAgentDescriptor({ ...descriptor(), port: 0 })).toThrow()
  })

  it('rejects a malformed identity and non-descriptor input', () => {
    expect(() =>
      validateOvenAgentDescriptor({
        ...descriptor(),
        identity: { algorithm: 'rsa', privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY }
      })
    ).toThrow()
    expect(() => decodeOvenAgentDescriptor('not a code')).toThrow()
    expect(() => decodeOvenAgentDescriptor('')).toThrow()
  })

  it('computes the ssh-keygen fingerprint of the included public key', () => {
    const blob = PUBLIC_KEY.split(' ')[1]
    const expected = `SHA256:${createHash('sha256')
      .update(Buffer.from(blob, 'base64'))
      .digest('base64')
      .replace(/=+$/u, '')}`
    expect(fingerprint(PUBLIC_KEY)).toBe(expected)
    expect(fingerprint(PUBLIC_KEY).startsWith('SHA256:')).toBe(true)
  })
})

describe('oven agent script generation', () => {
  it('builds a self-contained POSIX installer that parses as sh', () => {
    const script = buildOvenAgentScript({
      platform: 'linux',
      identity: true,
      bootstrapNode: true,
      service: BUNDLE,
      serviceRevision: REVISION,
      protocolVersion: 1
    })
    expect(script.filename).toBe('codeinoven-oven-agent.sh')
    expect(script.content).toContain(BUNDLE.trim())
    expect(script.content).toContain(REVISION)
    // POSIX sh must accept the whole file, heredocs and all.
    const check = spawnSync('sh', ['-n'], { input: script.content, encoding: 'utf8' })
    expect(check.stderr).toBe('')
    expect(check.status).toBe(0)
  })

  it('omits identity provisioning when it was not requested', () => {
    const script = buildOvenAgentScript({
      platform: 'darwin',
      identity: false,
      bootstrapNode: true,
      service: BUNDLE,
      serviceRevision: REVISION,
      protocolVersion: 1
    })
    expect(script.content).toContain("IDENTITY_ENABLED='0'")
    expect(script.content).not.toContain('authorized_keys')
  })

  it('builds a Windows installer that keeps the same core steps', () => {
    const script = buildOvenAgentScript({
      platform: 'win32',
      identity: true,
      bootstrapNode: true,
      service: BUNDLE,
      serviceRevision: REVISION,
      protocolVersion: 1
    })
    expect(script.filename).toBe('codeinoven-oven-agent.ps1')
    expect(script.content).toContain('$SERVICE_REVISION')
    expect(script.content).toContain('authorized_keys')
    expect(script.content).toContain('Move-Item -Force')
  })

  it('refuses a bundle that does not match its revision', () => {
    expect(() =>
      buildOvenAgentScript({
        platform: 'linux',
        identity: false,
        bootstrapNode: false,
        service: normalizeServiceBundle('changed\n'),
        serviceRevision: REVISION,
        protocolVersion: 1
      })
    ).toThrow(/revision/u)
  })
})

describe('oven agent runtime programs', () => {
  it('parses as JavaScript', () => {
    for (const [name, program] of [
      ['verify', AGENT_VERIFY_PROGRAM],
      ['descriptor', AGENT_DESCRIPTOR_PROGRAM]
    ] as const) {
      const file = join(scratch, `${name}.cjs`)
      writeFileSync(file, program)
      const check = spawnSync('node', ['--check', file], { encoding: 'utf8' })
      expect(check.stderr).toBe('')
      expect(check.status).toBe(0)
    }
  })

  it('verifies the exact bundle bytes', () => {
    const file = join(scratch, 'service.mjs')
    writeFileSync(file, BUNDLE)
    const run = () =>
      spawnSync('node', ['-'], {
        input: AGENT_VERIFY_PROGRAM,
        encoding: 'utf8',
        env: { ...process.env, CIO_AGENT_SERVICE_FILE: file, CIO_AGENT_REVISION: REVISION }
      })
    expect(run().status).toBe(0)
    const tampered = spawnSync('node', ['-'], {
      input: AGENT_VERIFY_PROGRAM,
      encoding: 'utf8',
      env: { ...process.env, CIO_AGENT_SERVICE_FILE: file, CIO_AGENT_REVISION: 'deadbeef' }
    })
    expect(tampered.status).not.toBe(0)
  })

  it('assembles a descriptor that the codec accepts', () => {
    const home = join(scratch, 'home')
    const ssh = join(home, '.ssh')
    mkdirSync(ssh, { recursive: true })
    writeFileSync(join(ssh, 'codeinoven-oven-agent'), PRIVATE_KEY)
    writeFileSync(join(ssh, 'codeinoven-oven-agent.pub'), `${PUBLIC_KEY}\n`)
    const descriptorFile = join(scratch, 'agent-registration.json')
    const output = execFileSync('node', ['-'], {
      input: AGENT_DESCRIPTOR_PROGRAM,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        CIO_AGENT_IDENTITY: '1',
        CIO_AGENT_PROTOCOL: '1',
        CIO_AGENT_REVISION: REVISION,
        CIO_AGENT_DATA_ROOT: join(home, 'data'),
        CIO_AGENT_USER: 'deploy',
        CIO_AGENT_PORT: '2222',
        CIO_AGENT_DESCRIPTOR_FILE: descriptorFile
      }
    })
    const decoded = decodeOvenAgentDescriptor(output)
    expect(decoded.port).toBe(2222)
    expect(decoded.user).toBe('deploy')
    expect(decoded.serviceRevision).toBe(REVISION)
    expect(decoded.identity?.publicKey).toBe(PUBLIC_KEY)
    const saved = JSON.parse(readFileSync(descriptorFile, 'utf8')) as OvenAgentDescriptor
    expect(saved.kind).toBe('codeinoven-oven-agent')
  })
})
