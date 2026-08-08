import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LAN_PORT,
  DEFAULT_MQTT_URL,
  DEFAULT_PWA_BASE_URL,
  DEFAULT_RELAY_URL,
  buildRemoteConfig,
  isProductionSource,
  isSecureProductionRelayUrl,
  loadRemoteConfig
} from './config'

const DEV: Record<string, string | boolean | number | undefined> = {
  PROD: false,
  DEV: true
}

const PROD: Record<string, string | boolean | number | undefined> = {
  PROD: true
}

describe('buildRemoteConfig', () => {
  it('applies the localhost-only development fallback for missing variables', () => {
    const config = buildRemoteConfig(DEV)

    expect(config.production).toBe(false)
    expect(config.lan.enabled).toBe(true)
    expect(config.lan.port).toBe(DEFAULT_LAN_PORT)
    expect(config.lan.localPort).toBe(DEFAULT_LAN_PORT + 1)
    expect(config.lan.useMdns).toBe(false)
    expect(config.lan.hosts).toEqual(['localhost'])
    expect(config.relay.enabled).toBe(true)
    expect(config.relay.url).toBe(DEFAULT_RELAY_URL)
    expect(config.relay.token).toBeNull()
    expect(config.relay.mqtt.url).toBe(DEFAULT_MQTT_URL)
    expect(config.relay.mqtt.username).toBeNull()
    expect(config.relay.mqtt.password).toBeNull()
    expect(config.peer.authSecret).toBeNull()
    expect(config.pwaBaseUrl).toBe(DEFAULT_PWA_BASE_URL)
  })

  it('reads explicit public variables and overrides the fallbacks', () => {
    const config = buildRemoteConfig({
      ...DEV,
      LAN_ENABLED: 'false',
      LAN_PORT: '5566',
      LAN_USE_MDNS: 'true',
      LAN_HOSTS: '192.168.1.10,192.168.1.11',
      RELAY_URL: 'wss://relay.example.test',
      RELAY_TOKEN: 'relay-token',
      MQTT_URL: 'wss://mqtt.example.test',
      MQTT_USERNAME: 'relay-user',
      MQTT_PASSWORD: 'relay-pass',
      PEER_SECRET_AUTH: 'peer-secret',
      PUBLIC_REMOTE_PWA_URL: 'https://remote.example.test'
    })

    expect(config.lan.enabled).toBe(false)
    expect(config.lan.port).toBe(5566)
    expect(config.lan.localPort).toBe(5567)
    expect(config.lan.useMdns).toBe(true)
    expect(config.lan.hosts).toEqual(['192.168.1.10', '192.168.1.11'])
    expect(config.relay.url).toBe('wss://relay.example.test')
    expect(config.relay.token).toBe('relay-token')
    expect(config.relay.mqtt.username).toBe('relay-user')
    expect(config.relay.mqtt.password).toBe('relay-pass')
    expect(config.peer.authSecret).toBe('peer-secret')
    expect(config.pwaBaseUrl).toBe('https://remote.example.test')
  })

  it('honours VITE_-prefixed variables as a renderer-bundle fallback', () => {
    const config = buildRemoteConfig({
      ...DEV,
      VITE_RELAY_URL: 'wss://vite-relay.example.test',
      VITE_PEER_SECRET_AUTH: 'vite-secret'
    })

    expect(config.relay.url).toBe('wss://vite-relay.example.test')
    expect(config.peer.authSecret).toBe('vite-secret')
  })

  it('keeps the relay disabled in production until credentials are provisioned', () => {
    const config = buildRemoteConfig(PROD)
    // LAN-first works with zero config; the relay is a deploy-time option that
    // stays disabled (never errors) until RELAY_URL/RELAY_TOKEN are supplied.
    expect(config.production).toBe(true)
    expect(config.lan.enabled).toBe(true)
    expect(config.relay.enabled).toBe(false)
  })

  it('enables the relay in production only for an explicit secure wss URL plus token', () => {
    const config = buildRemoteConfig({
      ...PROD,
      RELAY_URL: 'wss://relay.example.test',
      RELAY_TOKEN: 'relay-token'
    })
    // The env relay is no longer blanket-disabled in production: an explicit
    // `wss:` RELAY_URL plus a non-empty RELAY_TOKEN satisfies the contract.
    expect(config.relay.enabled).toBe(true)
    expect(config.relay.url).toBe('wss://relay.example.test')
    expect(config.relay.token).toBe('relay-token')
  })

  it('rejects an insecure ws relay URL in production', () => {
    const config = buildRemoteConfig({
      ...PROD,
      RELAY_URL: 'ws://relay.example.test',
      RELAY_TOKEN: 'relay-token'
    })
    expect(config.relay.enabled).toBe(false)
  })

  it('rejects a localhost relay URL in production', () => {
    const config = buildRemoteConfig({
      ...PROD,
      RELAY_URL: 'ws://localhost:8877',
      RELAY_TOKEN: 'relay-token'
    })
    expect(config.relay.enabled).toBe(false)
  })

  it('rejects a production relay URL that is not parseable', () => {
    const config = buildRemoteConfig({
      ...PROD,
      RELAY_URL: 'not-a-url',
      RELAY_TOKEN: 'relay-token'
    })
    expect(config.relay.enabled).toBe(false)
  })

  it('keeps the relay disabled in production when the token is missing', () => {
    const config = buildRemoteConfig({
      ...PROD,
      RELAY_URL: 'wss://relay.example.test'
    })
    expect(config.relay.enabled).toBe(false)
  })

  it('does not throw in production when all routes are disabled', () => {
    const config = buildRemoteConfig({
      ...PROD,
      RELAY_ENABLED: 'false',
      LAN_ENABLED: 'false'
    })

    expect(config.relay.enabled).toBe(false)
    expect(config.lan.enabled).toBe(false)
    expect(config.production).toBe(true)
  })

  it('works in production with LAN-only and no peer secret in the environment', () => {
    // The peer secret is auto-generated by the desktop and delivered through
    // the QR pairing URL — a production LAN setup never needs it from env.
    const config = buildRemoteConfig({
      ...PROD,
      RELAY_ENABLED: 'false'
    })
    expect(config.production).toBe(true)
    expect(config.lan.enabled).toBe(true)
    expect(config.peer.authSecret).toBeNull()
  })

  it('keeps MQTT signaling disabled in production until credentials are provisioned', () => {
    const config = buildRemoteConfig({
      ...PROD,
      RELAY_URL: 'wss://relay.example.test',
      RELAY_TOKEN: 'token',
      MQTT_URL: 'wss://mqtt.example.test'
    })
    // MQTT configured without credentials → the relay route stays disabled.
    expect(config.relay.enabled).toBe(false)
  })

  it('keeps production renderer secrets out of the effective configuration', () => {
    const config = buildRemoteConfig({
      ...PROD,
      RELAY_URL: 'wss://relay.example.test',
      RELAY_TOKEN: 'token',
      MQTT_URL: 'wss://mqtt.example.test',
      MQTT_USERNAME: 'user',
      MQTT_PASSWORD: 'pass',
      PEER_SECRET_AUTH: 'peer-secret'
    })

    expect(config.relay.token).toBe('token')
    expect(config.relay.mqtt.username).toBe('user')
    expect(config.peer.authSecret).toBeNull()
  })

  it('honours an explicit production override regardless of env flags', () => {
    const config = buildRemoteConfig({}, { production: true })
    expect(config.production).toBe(true)
    // LAN-first remains available; only the relay requires provisioning.
    expect(config.lan.enabled).toBe(true)
    expect(config.relay.enabled).toBe(false)
  })
})

describe('isProductionSource', () => {
  it('detects production from boolean and string PROD flags', () => {
    expect(isProductionSource({ PROD: true })).toBe(true)
    expect(isProductionSource({ PROD: 'true' })).toBe(true)
    expect(isProductionSource({ PROD: false })).toBe(false)
  })

  it('falls back to NODE_ENV', () => {
    expect(isProductionSource({ NODE_ENV: 'production' })).toBe(true)
    expect(isProductionSource({ NODE_ENV: 'development' })).toBe(false)
  })
})

describe('isSecureProductionRelayUrl', () => {
  it('accepts an explicit wss URL on a non-loopback host', () => {
    expect(isSecureProductionRelayUrl('wss://relay.example.test')).toBe(true)
  })

  it('rejects plain ws URLs, loopback hosts, and malformed input', () => {
    expect(isSecureProductionRelayUrl('ws://relay.example.test')).toBe(false)
    expect(isSecureProductionRelayUrl('wss://localhost:8877')).toBe(false)
    expect(isSecureProductionRelayUrl('wss://127.0.0.1:8877')).toBe(false)
    expect(isSecureProductionRelayUrl('wss://[::1]:8877')).toBe(false)
    expect(isSecureProductionRelayUrl('not-a-url')).toBe(false)
  })
})

describe('loadRemoteConfig', () => {
  it('builds a dev config from the platform environment without throwing', () => {
    expect(() => loadRemoteConfig()).not.toThrow()
    expect(loadRemoteConfig().lan.port).toBeGreaterThan(0)
  })
})
