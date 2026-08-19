import { afterEach, describe, expect, it } from 'vitest'
import {
  COOLIFY_BASE_URL_ENV,
  getCoolifyDeploymentReadiness,
  resolveCoolifyBaseUrl,
  validateBaseUrl
} from '../../../src/main/providers/base-url'

const production = { development: false }
const development = { development: true }

afterEach(() => {
  delete process.env[COOLIFY_BASE_URL_ENV]
  delete process.env['NODE_ENV']
})

describe('validateBaseUrl', () => {
  it('rejects empty and whitespace-only values', () => {
    expect(validateBaseUrl('', development).ok).toBe(false)
    expect(validateBaseUrl('   ', development).ok).toBe(false)
    expect(validateBaseUrl('', development).reason).toContain('empty')
  })

  it('rejects malformed and non-absolute URLs', () => {
    expect(validateBaseUrl('not-a-url', development).ok).toBe(false)
    expect(validateBaseUrl('coolify-host:8080', development).ok).toBe(false)
  })

  it('rejects non-http(s) schemes and embedded credentials', () => {
    expect(validateBaseUrl('ftp://coolify.example.com', development).ok).toBe(false)
    expect(validateBaseUrl('https://user:pass@coolify.example.com', development).ok).toBe(false)
  })

  it('rejects URLs with a query or fragment', () => {
    expect(validateBaseUrl('https://coolify.example.com?debug=1', development).ok).toBe(false)
    expect(validateBaseUrl('https://coolify.example.com/#frag', development).ok).toBe(false)
  })

  it('rejects invented placeholder and documentation hosts', () => {
    expect(validateBaseUrl('https://example.com', development).ok).toBe(false)
    expect(validateBaseUrl('https://app.example.com', development).ok).toBe(false)
    expect(validateBaseUrl('https://app.example.net', development).ok).toBe(false)
    expect(validateBaseUrl('https://coolify.example', development).ok).toBe(false)
    expect(validateBaseUrl('https://coolify.local', development).ok).toBe(false)
    expect(validateBaseUrl('https://coolify.test', development).ok).toBe(false)
  })

  it('rejects bare hostnames and private IP addresses as invented hosts', () => {
    expect(validateBaseUrl('https://coolify', development).ok).toBe(false)
    expect(validateBaseUrl('https://192.168.1.10', development).ok).toBe(false)
    expect(validateBaseUrl('https://10.0.0.5', development).ok).toBe(false)
  })

  it('rejects unverified plain-http non-localhost hosts', () => {
    expect(validateBaseUrl('http://coolify.example.com', development).ok).toBe(false)
    expect(validateBaseUrl('http://coolify.example.com', production).ok).toBe(false)
  })

  it('permits localhost only in development', () => {
    expect(validateBaseUrl('http://localhost:8080', development)).toMatchObject({
      ok: true,
      baseUrl: 'http://localhost:8080'
    })
    expect(validateBaseUrl('https://127.0.0.1', development).ok).toBe(true)
    expect(validateBaseUrl('http://localhost:8080', production).ok).toBe(false)
    expect(validateBaseUrl('http://localhost:8080', production).reason).toContain('localhost')
  })

  it('accepts ordinary hostnames that merely start with IPv6 private prefixes', () => {
    expect(validateBaseUrl('https://fc.example-host.dev', development).ok).toBe(true)
  })

  it('accepts an explicit verified HTTPS host and normalizes the base URL', () => {
    const result = validateBaseUrl('https://coolify.internal/api/v1/', development)
    expect(result).toEqual({
      ok: true,
      baseUrl: 'https://coolify.internal/api/v1'
    })
    expect(result.reason).toBeUndefined()
  })
})

describe('resolveCoolifyBaseUrl', () => {
  it('returns null when the env var is unset or invalid', () => {
    expect(resolveCoolifyBaseUrl({})).toBeNull()
    expect(resolveCoolifyBaseUrl({ [COOLIFY_BASE_URL_ENV]: 'https://example.com' })).toBeNull()
  })

  it('resolves an explicit verified host', () => {
    expect(
      resolveCoolifyBaseUrl({
        [COOLIFY_BASE_URL_ENV]: 'https://coolify.internal',
        NODE_ENV: 'production'
      })
    ).toBe('https://coolify.internal')
  })
})

describe('getCoolifyDeploymentReadiness', () => {
  it('is not ready without a value in production', () => {
    const readiness = getCoolifyDeploymentReadiness({ NODE_ENV: 'production' })
    expect(readiness.ready).toBe(false)
    expect(readiness.baseUrl).toBeNull()
    expect(readiness.reason).toContain('empty')
  })

  it('is not ready when the value is invalid in production', () => {
    const readiness = getCoolifyDeploymentReadiness({
      NODE_ENV: 'production',
      [COOLIFY_BASE_URL_ENV]: 'https://example.com'
    })
    expect(readiness.ready).toBe(false)
  })

  it('is not ready for localhost in production, but is ready in development', () => {
    expect(
      getCoolifyDeploymentReadiness({
        NODE_ENV: 'production',
        [COOLIFY_BASE_URL_ENV]: 'http://localhost:8080'
      }).ready
    ).toBe(false)
    expect(
      getCoolifyDeploymentReadiness({
        NODE_ENV: 'development',
        [COOLIFY_BASE_URL_ENV]: 'http://localhost:8080'
      })
    ).toEqual({ ready: true, baseUrl: 'http://localhost:8080' })
  })

  it('is ready only with a real verified host in production', () => {
    const readiness = getCoolifyDeploymentReadiness({
      NODE_ENV: 'production',
      [COOLIFY_BASE_URL_ENV]: 'https://coolify.internal'
    })
    expect(readiness).toEqual({
      ready: true,
      baseUrl: 'https://coolify.internal'
    })
  })
})
