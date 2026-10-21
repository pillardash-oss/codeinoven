/**
 * What to tell someone when their computer cannot reach an Oven at all.
 *
 * A private address that refuses to answer has two very different causes, and
 * only one of them is visible from here. The Oven can genuinely be off, and on
 * macOS the operating system also blocks an app's traffic to the local network
 * until the person allows it: nothing about that refusal says "blocked", the
 * connection simply fails as if the machine were switched off, and an app that
 * reported "unreachable" for it sent its owner looking at the wrong machine for
 * an hour. A private address is the only place the second cause can apply, so
 * that is the only case where the message mentions it.
 *
 * This module is free of Electron and of process control so the decision is
 * testable on any platform.
 */

/** Whether an Oven address is on the local network rather than the internet. */
export function isLocalNetworkHost(host: string): boolean {
  const value = host.trim().replace(/^\[/u, '').replace(/\]$/u, '').toLowerCase()
  if (value.length === 0) return false
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(value)
  if (ipv4) {
    const first = Number(ipv4[1])
    const second = Number(ipv4[2])
    if (first === 10 || first === 127) return true
    if (first === 192 && second === 168) return true
    if (first === 172 && second >= 16 && second <= 31) return true
    if (first === 169 && second === 254) return true
    return false
  }
  // Link-local and unique-local IPv6 are local; a global address is not.
  if (value.includes(':')) return value.startsWith('fe80:') || value.startsWith('fd')
  // A single label, or a `.local` name, is resolved by the local network.
  return !value.includes('.') || value.endsWith('.local')
}

/**
 * The message for a host that could not be reached.
 *
 * `platform` is passed in rather than read from the process so the caller can
 * decide with the same value it reports everywhere else, and so this stays a
 * pure function.
 */
export function unreachableHostIssue(platform: NodeJS.Platform, host: string): string {
  const unreachable = 'This host is unreachable from this computer.'
  if (platform !== 'darwin' || !isLocalNetworkHost(host)) return unreachable
  return `${unreachable} macOS also blocks an app's local network access until it is allowed: open System Settings, Privacy & Security, Local Network, and turn this app on, then try again.`
}
