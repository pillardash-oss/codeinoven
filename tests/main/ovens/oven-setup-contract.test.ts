import { describe, expect, it, vi } from 'vitest'
import { assessPreflight, nodeSatisfiesServiceRequirement } from '../../../src/main/ovens/oven-setup-capabilities'
import type { OvenPreflightReport } from '../../../src/lib/ovens'
import { validateStartOvenSetup } from '../../../src/main/ovens/oven-validation'
import type { SecretVault } from '../../../src/main/storage/secret-vault'
import { buildSetupPlan } from '../../../src/main/ovens/remote/oven-setup-script'
import { planNodeInstall } from '../../../src/main/ovens/oven-setup-bootstrap'

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
    expect(plan.steps.map((step) => step.id).slice(0, 4)).toEqual(['preflight', 'packages', 'git', 'curl'])
    expect(plan.steps.findIndex((step) => step.id === 'node')).toBeGreaterThan(1)
  })

  it('refreshes and upgrades zypper packages before prerequisites', () => {
    const assessment = assessPreflight(report({
      packageManager: 'zypper',
      node: { installed: false, version: null, path: null },
      npm: { installed: false, version: null, path: null }
    }))
    const plan = buildSetupPlan(assessment, {
      selectedHarnesses: [],
      synchronizeAccounts: false,
      synchronizeConfiguration: false,
      git: { enabled: false, host: 'github' },
      packageUpgrades: true
    })
    expect(plan.blockers).toEqual([])
    expect(plan.steps.find((step) => step.id === 'packages')?.commands.map((entry) => entry.command)).toEqual([
      'zypper',
      'zypper'
    ])
    expect(plan.steps.findIndex((step) => step.id === 'curl')).toBeLessThan(
      plan.steps.findIndex((step) => step.id === 'node')
    )
  })

  it('installs missing npm after confirming Node is ready', () => {
    const assessment = assessPreflight(report({
      packageManager: 'zypper',
      npm: { installed: false, version: null, path: null }
    }))
    const plan = buildSetupPlan(assessment, {
      selectedHarnesses: [],
      synchronizeAccounts: false,
      synchronizeConfiguration: false,
      git: { enabled: false, host: 'github' },
      packageUpgrades: false
    })
    expect(plan.steps.findIndex((step) => step.id === 'node')).toBeLessThan(
      plan.steps.findIndex((step) => step.id === 'npm')
    )
    expect(plan.steps.find((step) => step.id === 'npm')?.commands[0]?.command).toBe('zypper')
  })

  it('uses the published NodeSource 22 RPM setup channel', () => {
    const plan = planNodeInstall('linux', 'x64', 'dnf', 'passwordless-sudo')
    expect(plan.commands[0]?.command).toBe('sh')
    expect(plan.commands[0]?.args[1]).toContain('https://rpm.nodesource.com/setup_22.x')
    expect(plan.commands[0]?.elevated).toBe(true)
  })

  it('installs Node.js through Scoop on native Windows when it is the available manager', () => {
    const plan = planNodeInstall('win32', 'arm64', 'scoop', 'none')
    expect(plan.method).toBe('scoop')
    expect(plan.commands[0]).toMatchObject({ command: 'scoop', args: ['install', 'nodejs-lts'] })
    expect(plan.commands[0]?.elevated).toBe(false)
  })

  it('runs the Winget upgrade operation for every installed package', () => {
    const assessment = assessPreflight(report({ platform: 'win32', osName: 'Windows', packageManager: 'winget' }))
    const plan = buildSetupPlan(assessment, {
      selectedHarnesses: [],
      synchronizeAccounts: false,
      synchronizeConfiguration: false,
      git: { enabled: false, host: 'github' },
      packageUpgrades: true
    })
    expect(plan.steps.find((step) => step.id === 'packages')?.commands[0]?.args).toContain('--all')
  })

  it('uses the cURL WinGet package when curl is missing on Windows', () => {
    const assessment = assessPreflight(report({
      platform: 'win32',
      osName: 'Windows',
      packageManager: 'winget',
      curl: { installed: false, version: null, path: null }
    }))
    const plan = buildSetupPlan(assessment, {
      selectedHarnesses: [],
      synchronizeAccounts: false,
      synchronizeConfiguration: false,
      git: { enabled: false, host: 'github' },
      packageUpgrades: false
    })
    expect(plan.steps.find((step) => step.id === 'curl')?.commands[0]?.args).toContain('cURL.cURL')
  })

  it('stores the setup private key in the vault and returns only a reference', async () => {
    const save = vi.fn(async () => 'private-key-ref')
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
        privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nkey-data\n-----END OPENSSH PRIVATE KEY-----'
      }
    }, vault)

    expect(configuration.git.privateKeyRef).toBe('private-key-ref')
    expect(JSON.stringify(configuration)).not.toContain('key-data')
    expect(save).toHaveBeenCalledOnce()
  })

  it('rejects an Oven key passphrase instead of storing an unused secret', async () => {
    const vault = { save: vi.fn(async () => 'private-key-ref') } as unknown as SecretVault
    await expect(validateStartOvenSetup({
      configuration: {
        selectedHarnesses: [],
        synchronizeAccounts: false,
        synchronizeConfiguration: false,
        git: { enabled: true, host: 'github' },
        packageUpgrades: true
      },
      gitIdentity: {
        privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nkey-data\n-----END OPENSSH PRIVATE KEY-----',
        passphrase: 'not-supported'
      }
    }, vault)).rejects.toThrow('does not accept key passphrases')
  })
})
