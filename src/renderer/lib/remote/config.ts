/**
 * Remote-connection configuration.
 *
 * Every connection setting is read exclusively from public environment
 * variables. Missing values fall back to a documented localhost-only
 * development default — a production domain is never invented. In production
 * builds, missing relay credentials raise a descriptive configuration error
 * instead of silently degrading.
 *
 * The renderer bundle can only see `VITE_`-prefixed variables, so each key is
 * resolved from its canonical name first and a `VITE_`-prefixed variant second
 * (e.g. `RELAY_URL` then `VITE_RELAY_URL`). See `agent-out/config.md`.
 */

export const DEFAULT_LAN_PORT = 4455
export const DEFAULT_RELAY_URL = 'ws://localhost:8877'
export const DEFAULT_MQTT_URL = 'ws://localhost:8883'
export const DEFAULT_PWA_BASE_URL = 'http://localhost:5173'

export interface LanSettings {
  enabled: boolean
  port: number
  /** Loopback-only ws port for the desktop renderer's in-app connection. */
  localPort: number
  useMdns: boolean
  hosts: string[]
}

export interface RelayMqttSettings {
  url: string | null
  username: string | null
  password: string | null
}

export interface RelaySettings {
  enabled: boolean
  url: string
  token: string | null
  mqtt: RelayMqttSettings
}

export interface PeerSettings {
  authSecret: string | null
}

export interface RemoteConfig {
  lan: LanSettings
  relay: RelaySettings
  peer: PeerSettings
  pwaBaseUrl: string
  production: boolean
}

/** Loose environment shape: booleans and numbers are tolerated (Vite envs). */
export type RemoteConfigSource = Record<string, string | boolean | number | undefined>

/** Raised when a production build requires non-empty relay credentials. */
export class RemoteConfigError extends Error {
  constructor(
    message: string,
    readonly missingVariables: readonly string[]
  ) {
    super(message)
    this.name = 'RemoteConfigError'
  }
}

/** Resolve the effective environment for the running platform. */
export function readRemoteEnv(): RemoteConfigSource {
  const meta = import.meta as unknown as { env?: RemoteConfigSource }
  if (meta.env && typeof meta.env === 'object') return meta.env
  return {}
}

/** Read a string variable by canonical name, with a VITE_-prefixed fallback. */
function envString(source: RemoteConfigSource, key: string): string | null {
  const value = source[key] ?? source[`VITE_${key}`]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function envBool(source: RemoteConfigSource, key: string, fallback: boolean): boolean {
  const value = envString(source, key)
  if (value === null) return fallback
  return value === 'true' || value === '1' || value.toLowerCase() === 'yes'
}

function envInt(source: RemoteConfigSource, key: string, fallback: number): number {
  const value = envString(source, key)
  if (value === null) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function envList(source: RemoteConfigSource, key: string, fallback: string[]): string[] {
  const value = envString(source, key)
  if (value === null) return fallback
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/** Whether the running build is a production build. */
export function isProductionSource(source: RemoteConfigSource): boolean {
  if (typeof source['PROD'] === 'boolean') return source['PROD']
  const prod = source['PROD'] ?? source['VITE_PROD']
  if (prod === 'true' || prod === '1') return true
  return envString(source, 'NODE_ENV') === 'production'
}

export interface BuildRemoteConfigOptions {
  production?: boolean
}

/**
 * Build validated connection settings from an environment source.
 *
 * @throws {RemoteConfigError} in production when the relay is enabled but
 *   `RELAY_URL`/`RELAY_TOKEN` are missing, or when MQTT is enabled but its
 *   credentials are missing.
 */
export function buildRemoteConfig(
  source: RemoteConfigSource,
  options: BuildRemoteConfigOptions = {}
): RemoteConfig {
  const production = options.production ?? isProductionSource(source)

  const relayEnabled = envBool(source, 'RELAY_ENABLED', true)
  const lanEnabled = envBool(source, 'LAN_ENABLED', true)
  const relayUrl = envString(source, 'RELAY_URL') ?? (production ? null : DEFAULT_RELAY_URL)
  const relayToken = envString(source, 'RELAY_TOKEN')

  const mqttUrl = envString(source, 'MQTT_URL') ?? (production ? null : DEFAULT_MQTT_URL)
  const mqttUsername = envString(source, 'MQTT_USERNAME')
  const mqttPassword = envString(source, 'MQTT_PASSWORD')

  const missing: string[] = []
  if (production && relayEnabled && relayUrl === null) missing.push('RELAY_URL')
  if (production && relayEnabled && relayToken === null) missing.push('RELAY_TOKEN')
  if (
    production &&
    relayEnabled &&
    mqttUrl !== null &&
    (mqttUsername === null || mqttPassword === null)
  ) {
    if (mqttUsername === null) missing.push('MQTT_USERNAME')
    if (mqttPassword === null) missing.push('MQTT_PASSWORD')
  }
  // Every handshake on both routes requires the shared peer secret.
  if (
    production &&
    (lanEnabled || relayEnabled) &&
    envString(source, 'PEER_SECRET_AUTH') === null
  ) {
    missing.push('PEER_SECRET_AUTH')
  }
  if (missing.length > 0) {
    const names = missing.join(', ')
    throw new RemoteConfigError(
      `Remote connection requires production values for: ${names}. ` +
        `Supply these public environment variables at deploy time; they are never invented.`,
      missing
    )
  }

  return {
    lan: {
      enabled: lanEnabled,
      port: envInt(source, 'LAN_PORT', DEFAULT_LAN_PORT),
      localPort: envInt(source, 'LAN_LOCAL_PORT', envInt(source, 'LAN_PORT', DEFAULT_LAN_PORT) + 1),
      useMdns: envBool(source, 'LAN_USE_MDNS', false),
      hosts: envList(source, 'LAN_HOSTS', ['localhost'])
    },
    relay: {
      enabled: relayEnabled,
      url: relayUrl ?? DEFAULT_RELAY_URL,
      token: relayToken,
      mqtt: {
        url: mqttUrl,
        username: mqttUsername,
        password: mqttPassword
      }
    },
    peer: {
      authSecret: envString(source, 'PEER_SECRET_AUTH')
    },
    pwaBaseUrl: envString(source, 'PUBLIC_REMOTE_PWA_URL') ?? DEFAULT_PWA_BASE_URL,
    production
  }
}

/** Build settings from the platform environment with localhost-only fallbacks. */
export function loadRemoteConfig(options: BuildRemoteConfigOptions = {}): RemoteConfig {
  return buildRemoteConfig(readRemoteEnv(), options)
}
