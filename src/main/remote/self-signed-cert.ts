/**
 * Self-signed TLS certificate for the LAN gateway.
 *
 * The phone client is an installable PWA, and browsers only register service
 * workers / offer install in a secure context. Serving the PWA over plain LAN
 * HTTP defeats installability, so the gateway serves it over HTTPS with a
 * self-signed certificate generated at runtime. The certificate is persisted
 * under the app's user-data directory and regenerated only when the machine's
 * LAN IP set changes (so the fingerprint stays stable across launches while
 * the certificate always covers the current interface).
 */

import { generate } from 'selfsigned'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { networkInterfaces } from 'node:os'
import { isIP } from 'node:net'
import { Logger } from '../system/logger'

export interface SelfSignedCertificate {
  key: string
  cert: string
  hosts: string[]
}

const VIRTUAL_INTERFACE_PATTERN =
  /^(?:lo|utun|tun|tap|awdl|llw|anpi|gif|stf|docker|veth|br-|bridge|vmnet|vbox|tailscale|zt)/i

function usableLanAddress(address: string): boolean {
  if (address.startsWith('127.') || address.startsWith('169.254.')) return false
  const normalized = address.toLowerCase()
  return normalized !== '::' && normalized !== '::1' && !normalized.startsWith('fe80:')
}

function lanAddressPriority(address: string): number {
  if (address.startsWith('192.168.')) return 0
  if (address.startsWith('10.')) return 1
  const secondOctet = Number(address.split('.')[1])
  if (address.startsWith('172.') && secondOctet >= 16 && secondOctet <= 31) return 2
  return address.includes(':') ? 4 : 3
}

export function detectPreferredLanIps(): string[] {
  const physical: string[] = []
  const fallback: string[] = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const info of entries ?? []) {
      if (info.internal || (info.family !== 'IPv4' && info.family !== 'IPv6')) continue
      if (isIP(info.address) === 0) continue
      const normalized = info.address.includes('%') ? info.address.split('%')[0] : info.address
      if (!usableLanAddress(normalized)) continue
      fallback.push(normalized)
      if (!VIRTUAL_INTERFACE_PATTERN.test(name)) physical.push(normalized)
    }
  }
  const candidates = physical.length > 0 ? physical : fallback
  return [...new Set(candidates)].sort(
    (left, right) =>
      lanAddressPriority(left) - lanAddressPriority(right) || left.localeCompare(right)
  )
}

export function detectLanIps(): string[] {
  const ips = new Set<string>()
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const info of interfaces ?? []) {
      if (info.internal) continue
      if (info.family !== 'IPv4' && info.family !== 'IPv6') continue
      if (isIP(info.address) === 0) continue
      const normalized = info.address.includes('%') ? info.address.split('%')[0] : info.address
      ips.add(normalized)
    }
  }
  return [...ips].sort()
}

function normalizeHost(host: string): string {
  return host.trim().replace(/(^\[|\]$)/g, '')
}

function sameHosts(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((host, index) => normalizeHost(host) === normalizeHost(b[index]))
}

async function writeCertificateMetadata(
  directory: string,
  hosts: string[],
  preferredHosts: string[]
): Promise<void> {
  const target = join(directory, 'meta.json')
  const temporary = `${target}.tmp`
  await writeFile(
    temporary,
    JSON.stringify({
      hosts: hosts.map(normalizeHost),
      preferredHosts: preferredHosts.map(normalizeHost)
    }),
    { encoding: 'utf8' }
  )
  await rename(temporary, target)
}

async function readStored(dir: string, hosts: string[]): Promise<SelfSignedCertificate | null> {
  try {
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as {
      hosts: string[]
    }
    if (!Array.isArray(meta.hosts) || !sameHosts(meta.hosts, hosts)) return null
    const [key, cert] = await Promise.all([
      readFile(join(dir, 'key.pem'), 'utf8'),
      readFile(join(dir, 'cert.pem'), 'utf8')
    ])
    return { key, cert, hosts }
  } catch {
    return null
  }
}

/** Load a persisted self-signed certificate or generate and persist a new one. */
export async function loadOrCreateSelfSignedCertificate(
  directory: string
): Promise<SelfSignedCertificate> {
  const hosts = detectLanIps()
  const preferredHosts = detectPreferredLanIps()
  const existing = await readStored(directory, hosts)
  if (existing) {
    await writeCertificateMetadata(directory, hosts, preferredHosts)
    return existing
  }

  const result = await generate([{ name: 'commonName', value: 'CodeInOven Remote Gateway' }], {
    algorithm: 'sha256',
    keySize: 2048,
    notAfterDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: '::1' },
          ...hosts.map((ip) => ({ type: 7 as const, ip }))
        ]
      }
    ]
  })

  await mkdir(directory, { recursive: true })
  await Promise.all([
    writeFile(join(directory, 'key.pem'), result.private, { encoding: 'utf8', mode: 0o600 }),
    writeFile(join(directory, 'cert.pem'), result.cert, { encoding: 'utf8' }),
    writeCertificateMetadata(directory, hosts, preferredHosts)
  ])
  Logger.info('Generated self-signed certificate for the remote gateway', {
    hosts,
    fingerprint: result.fingerprint
  })
  return { key: result.private, cert: result.cert, hosts }
}
