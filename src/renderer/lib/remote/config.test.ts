import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LAN_PORT,
  DEFAULT_MQTT_URL,
  DEFAULT_PWA_BASE_URL,
  DEFAULT_RELAY_URL,
  RemoteConfigError,
  buildRemoteConfig,
  isProductionSource,
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

  it('throws a descriptive error when production requires relay credentials', () => {
    expect(() => buildRemoteConfig(PROD)).toThrowError(RemoteConfigError)
    expect(() => buildRemoteConfig(PROD)).toThrowError(/RELAY_URL/)
    expect(() => buildRemoteConfig(PROD)).toThrowError(/RELAY_TOKEN/)
  })

  it('throws when production enables the relay but the token is missing', () => {
    expect(() =>
      buildRemoteConfig({
        ...PROD,
        RELAY_URL: 'wss://relay.example.test'
      })
    ).toThrowError(/RELAY_TOKEN/)
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

  it('throws in production when the peer secret is missing and a route is enabled', () => {
    expect(() =>
      buildRemoteConfig({
        ...PROD,
        RELAY_ENABLED: 'false'
      })
    ).toThrowError(/PEER_SECRET_AUTH/)
    expect(() => buildRemoteConfig(PROD)).toThrowError(/PEER_SECRET_AUTH/)
  })

  it('throws when production enables MQTT signaling without credentials', () => {
    expect(() =>
      buildRemoteConfig({
        ...PROD,
        RELAY_URL: 'wss://relay.example.test',
        RELAY_TOKEN: 'token',
        MQTT_URL: 'wss://mqtt.example.test'
      })
    ).toThrowError(/MQTT_USERNAME/)
    expect(() =>
      buildRemoteConfig({
        ...PROD,
        RELAY_URL: 'wss://relay.example.test',
        RELAY_TOKEN: 'token',
        MQTT_URL: 'wss://mqtt.example.test',
        MQTT_USERNAME: 'user'
      })
    ).toThrowError(/MQTT_PASSWORD/)
  })

  it('accepts a complete production configuration', () => {
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
    expect(config.peer.authSecret).toBe('peer-secret')
  })

  it('exposes an explicit production override regardless of env flags', () => {
    expect(() => buildRemoteConfig({}, { production: true })).toThrowError(RemoteConfigError)
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

describe('loadRemoteConfig', () => {
  it('builds a dev config from the platform environment without throwing', () => {
    expect(() => loadRemoteConfig()).not.toThrow()
    expect(loadRemoteConfig().lan.port).toBeGreaterThan(0)
  })
})
