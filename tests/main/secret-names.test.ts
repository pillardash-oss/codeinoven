import { describe, expect, it } from 'vitest'
import {
  deriveAppEnvironmentVariable,
  isAppOwnedEnvironmentVariable,
  validateAppEnvironmentVariable,
  validateTargetEnvironmentVariable
} from '../../src/lib/secret-names'

describe('secret name rules', () => {
  it('derives an app-owned name that cannot collide with a harness variable', () => {
    expect(deriveAppEnvironmentVariable('A1B2C3D4', 'Coolify API token')).toBe(
      'CIO_A1B2C3D4_COOLIFY_API_TOKEN'
    )
    expect(isAppOwnedEnvironmentVariable('CIO_A1B2C3D4_COOLIFY_API_TOKEN')).toBe(true)
  })

  it('refuses a name the OS or a runtime already owns', () => {
    for (const name of ['PATH', 'Path', 'LD_PRELOAD', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES']) {
      expect(() => validateTargetEnvironmentVariable(name)).toThrow()
    }
  })

  it('refuses a name in the app namespace, and accepts a target name that is not', () => {
    expect(() => validateTargetEnvironmentVariable('CIO_OVEN_KEY_PASSPHRASE')).toThrow()
    expect(validateTargetEnvironmentVariable('GITHUB_PERSONAL_ACCESS_TOKEN')).toBe(
      'GITHUB_PERSONAL_ACCESS_TOKEN'
    )
  })

  it('requires the app prefix for a variable the app invents', () => {
    expect(() => validateAppEnvironmentVariable('COOLIFY_TOKEN')).toThrow()
    expect(validateAppEnvironmentVariable('CIO_COOLIFY_TOKEN')).toBe('CIO_COOLIFY_TOKEN')
  })
})
