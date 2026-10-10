import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_PROTOCOL_PERMISSION,
  externalProtocolAppLabel,
  externalProtocolTarget
} from '../../../src/lib/browser/external-protocol'

describe('external protocol handoff', () => {
  it('names a known scheme and keeps the address the OS would open', () => {
    const target = externalProtocolTarget(
      'macappstore://apps.apple.com/us/app/milogs/id6759716367?platform=mac&mt=12'
    )
    expect(target).not.toBeNull()
    expect(target?.scheme).toBe('macappstore')
    expect(target?.label).toBe('the Mac App Store')
    expect(target?.url).toBe(
      'macappstore://apps.apple.com/us/app/milogs/id6759716367?platform=mac&mt=12'
    )
  })

  it('lowercases the scheme and still resolves its label', () => {
    const target = externalProtocolTarget('MACAPPSTORE://apps.apple.com/app/id1')
    expect(target?.scheme).toBe('macappstore')
    expect(target?.label).toBe('the Mac App Store')
  })

  it('names the common handoff schemes the app knows', () => {
    expect(externalProtocolTarget('mailto:hello@example.com')?.label).toBe('your email app')
    expect(externalProtocolTarget('tel:+15555550123')?.label).toBe('your phone app')
    expect(externalProtocolTarget('zoommtg://zoom.us/join?confno=1')?.label).toBe('Zoom')
  })

  it('still opens a scheme it has no label for, named generically', () => {
    const target = externalProtocolTarget('some-new-app://open/thing')
    expect(target).not.toBeNull()
    expect(target?.scheme).toBe('some-new-app')
    expect(target?.label).toBe('an external app')
  })

  it('refuses web addresses: they are pages, not handoffs', () => {
    expect(externalProtocolTarget('https://apps.apple.com/us/app/milogs/id6759716367')).toBeNull()
    expect(externalProtocolTarget('http://localhost:3000')).toBeNull()
  })

  it('refuses the schemes that must never reach an OS handler', () => {
    const denied = [
      'javascript:alert(1)',
      'data:text/html,<h1>x</h1>',
      'blob:https://example.com/1234',
      'file:///etc/passwd',
      'filesystem:https://example.com/temporary/x',
      'about:blank',
      'view-source:https://example.com',
      'chrome://settings',
      'chrome-extension://abcdef/page.html',
      'ws://localhost:8080/socket',
      'wss://example.com/socket',
      'devtools://devtools/bundled/inspector.html'
    ]
    for (const url of denied) {
      expect(externalProtocolTarget(url), url).toBeNull()
    }
  })

  it('refuses empty, malformed and oversized addresses', () => {
    expect(externalProtocolTarget('')).toBeNull()
    expect(externalProtocolTarget('not a url at all')).toBeNull()
    expect(externalProtocolTarget('://no-scheme')).toBeNull()
    expect(externalProtocolTarget(`myapp://${'a'.repeat(9000)}`)).toBeNull()
  })

  it('refuses an address carrying control characters', () => {
    expect(externalProtocolTarget('myapp://open\nnext')).toBeNull()
    expect(externalProtocolTarget('myapp://open\u0000next')).toBeNull()
  })

  it('accepts a space, encoding it the way the URL parser does', () => {
    const mail = externalProtocolTarget('mailto:hello@example.com?subject=Hello World')
    expect(mail).not.toBeNull()
    expect(mail?.url).toBe('mailto:hello@example.com?subject=Hello%20World')
    expect(externalProtocolTarget('zoommtg://zoom.us/join?uname=Jane Doe')?.url).toBe(
      'zoommtg://zoom.us/join?uname=Jane%20Doe'
    )
    // A space in the host is a genuinely malformed address, not a link.
    expect(externalProtocolTarget('myapp://open next')).toBeNull()
  })

  it('opens the companion apps a link hands off to', () => {
    const cases: [string, string, string][] = [
      ['zoommtg://zoom.us/join?action=join&confno=91234567890', 'Zoom', 'zoommtg'],
      ['slack://channel?team=T012345&id=C0678', 'Slack', 'slack'],
      ['discord://-/channels/@me', 'Discord', 'discord'],
      ['msteams://teams.microsoft.com/l/meetup-join/19%3ameeting', 'Microsoft Teams', 'msteams'],
      ['spotify:track:4cOdK2wGLETKBW3PvgPWqT', 'Spotify', 'spotify'],
      // Not every companion app is named; the scheme it uses still opens.
      ['zoomus://zoom.us/join?confno=91234567890', 'an external app', 'zoomus']
    ]
    for (const [url, label, scheme] of cases) {
      const target = externalProtocolTarget(url)
      expect(target, url).not.toBeNull()
      expect(target?.label, url).toBe(label)
      expect(target?.scheme, url).toBe(scheme)
    }
  })

  it('falls back to a generic name for an unknown scheme label', () => {
    expect(externalProtocolAppLabel('who-knows')).toBe('an external app')
    expect(externalProtocolAppLabel('mailto')).toBe('your email app')
  })

  it('exposes one shared prompt id for the handoff decision', () => {
    expect(EXTERNAL_PROTOCOL_PERMISSION).toBe('external-protocol')
  })
})
