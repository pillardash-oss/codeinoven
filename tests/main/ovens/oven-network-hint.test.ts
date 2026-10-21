import { describe, expect, it } from 'vitest'
import { isLocalNetworkHost, unreachableHostIssue } from '../../../src/main/ovens/oven-network-hint'

describe('unreachable Oven guidance', () => {
  it('recognizes every address family that can only mean the local network', () => {
    for (const host of ['192.168.0.101', '10.1.2.3', '172.16.4.4', '172.31.255.1', '169.254.3.9'])
      expect(isLocalNetworkHost(host)).toBe(true)
    expect(isLocalNetworkHost('[fe80::1]')).toBe(true)
    expect(isLocalNetworkHost('fd11:1ebc::5')).toBe(true)
    expect(isLocalNetworkHost('leonard-tab')).toBe(true)
    expect(isLocalNetworkHost('oven.local')).toBe(true)
    // A public address and a DNS name are not the local network.
    expect(isLocalNetworkHost('8.8.8.8')).toBe(false)
    expect(isLocalNetworkHost('oven.example.com')).toBe(false)
    expect(isLocalNetworkHost('')).toBe(false)
  })

  it('names the macOS local network setting only where it can apply', () => {
    const mac = unreachableHostIssue('darwin', '192.168.0.101')
    expect(mac).toContain('unreachable')
    expect(mac).toContain('Local Network')
    // A public Oven has nothing to do with the local network setting.
    expect(unreachableHostIssue('darwin', 'oven.example.com')).not.toContain('Local Network')
    // Other platforms have no such permission.
    expect(unreachableHostIssue('linux', '192.168.0.101')).not.toContain('Local Network')
    expect(unreachableHostIssue('win32', '192.168.64.10')).not.toContain('Local Network')
  })
})
