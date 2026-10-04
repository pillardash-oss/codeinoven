import { describe, expect, it, vi } from 'vitest'
import { assessPreflight, nodeSatisfiesServiceRequirement } from '../../../src/main/ovens/oven-setup-capabilities'
import type { OvenPreflightReport } from '../../../src/lib/ovens'
import { validateStartOvenSetup } from '../../../src/main/ovens/oven-validation'
import type { SecretVault } from '../../../src/main/storage/secret-vault'
import { buildSetupPlan } from '../../../src/main/ovens/remote/oven-setup-script'

function report(overrides: Partial<OvenPreflightReport> = {}): OvenPreflightReport {
  return {
    ovenId: 'oven-test',
    checkedAt: 1,
    platform: 'linux',
    architecture: 'x64',
    osName: 'Ubuntu',
    osVersion: '24.04',
    packageManager: 'apt',
    privilege: 'passwordless-sudo',
    git: { installed: true, version: '2.43.0', path: '/usr/bin/git' },
    curl: { installed: true, version: '8.5.0', path: '/usr/bin/curl' },
    node: { installed: true, version: 'v22.13.1', path: '/usr/bin/node' },
    npm: { installed: true, version: '10.5.0', path: '/usr/bin/npm' },
    harnesses: [],
    osUpdateRequired: false,
    rebootRequired: false,
    durationMs: 20,
    ...overrides
  }
}

describe('oven setup assessment', () => {
  it('accepts supported x64 Linux with required tools', () => {
    const result = assessPreflight(report())
    expect(result.supported).toBe(true)
    expect(result.prerequisitesSatisfied).toBe(true)
    expect(result.issues.filter((issue) => issue.blocking)).toEqual([])
  })

  it('reports missing Git as a prerequisite that can be installed through apt', () => {
    const result = assessPreflight(report({ git: { installed: false, version: null, path: null } }))
    expect(result.issues.some((issue) => issue.code === 'missing-git' && !issue.blocking)).toBe(true)
  })

  it('requires Node 22 or later', () => {
    expect(nodeSatisfiesServiceRequirement('v22.0.0')).toBe(true)
    expect(nodeSatisfiesServiceRequirement('v20.18.0')).toBe(false)
    expect(nodeSatisfiesServiceRequirement(null)).toBe(false)
  })

  it('upgrades packages before bootstrapping a missing Node runtime', () => {
    const assessment = assessPreflight(report({ node: { installed: false, version: null, path: null } }))
    const plan = buildSetupPlan(assessment, {
      selectedHarnesses: [],
      synchronizeAccounts: false,
      synchronizeConfiguration: false,
      git: { enabled: false, host: 'github' },
      packageUpgrades: true
    })
    expect(plan.blockers).toEqual([])
    expect(plan.steps.map((step) => step.id).slice(0, 3)).toEqual(['preflight', 'packages', 'node'])
  })

  it('stores setup identity secrets in the vault and returns only references', async () => {
    const save = vi.fn(async (value: string) => value.includes('PRIVATE KEY') ? 'private-key-ref' : 'passphrase-ref')
    const vault = { save } as unknown as SecretVault
    const configuration = await validateStartOvenSetup({
      configuration: {
        selectedHarnesses: [],
        synchronizeAccounts: false,
        synchronizeConfiguration: false,
        git: { enabled: true, host: 'github' },
        packageUpgrades: true
      },
      gitIdentity: {
        privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nkey-data\n-----END OPENSSH PRIVATE KEY-----',
        passphrase: 'oven-passphrase'
      }
    }, vault)

    expect(configuration.git.privateKeyRef).toBe('private-key-ref')
    expect(configuration.git.passphraseRef).toBe('passphrase-ref')
    expect(JSON.stringify(configuration)).not.toContain('oven-passphrase')
    expect(JSON.stringify(configuration)).not.toContain('key-data')
    expect(save).toHaveBeenCalledTimes(2)
  })
})
