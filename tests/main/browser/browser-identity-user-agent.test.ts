import { describe, expect, it } from 'vitest'
import {
  BROWSER_IDENTITY_USER_AGENT_ENV,
  browserIdentityUserAgent,
  identityUserAgentRequested,
  recordedRuntimeUserAgent,
  rememberRuntimeUserAgent
} from '../../../src/main/browser/browser-service/browser-identity-user-agent'

const CHROME_RUNTIME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'CodeInOven/0.5.67 Chrome/152.0.7977.167 Electron/44.9.3 Safari/537.36'

describe('browser identity user agent', () => {
  it('names the environment variable the switch reads', () => {
    expect(BROWSER_IDENTITY_USER_AGENT_ENV).toBe('CODEINOVEN_BROWSER_IDENTITY_UA')
  })

  it('treats only explicit truthy spellings as the switch being on', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
      expect(identityUserAgentRequested(value), value).toBe(true)
    }
    for (const value of [undefined, '', '0', 'false', 'off', 'identity', 'y']) {
      expect(identityUserAgentRequested(value), String(value)).toBe(false)
    }
  })

  it('offers no user agent while the switch is off', () => {
    expect(browserIdentityUserAgent(undefined, CHROME_RUNTIME_UA)).toBeNull()
    expect(browserIdentityUserAgent('0', CHROME_RUNTIME_UA)).toBeNull()
  })

  it('offers the recorded runtime user agent verbatim, app and runtime tokens included', () => {
    expect(browserIdentityUserAgent('1', CHROME_RUNTIME_UA)).toBe(CHROME_RUNTIME_UA)
    expect(browserIdentityUserAgent('1', CHROME_RUNTIME_UA)).toContain('Electron/')
  })

  it('offers nothing when startup never recorded a runtime user agent', () => {
    expect(browserIdentityUserAgent('1', null)).toBeNull()
  })

  it('remembers a recorded user agent and refuses an empty one', () => {
    rememberRuntimeUserAgent(CHROME_RUNTIME_UA)
    expect(recordedRuntimeUserAgent()).toBe(CHROME_RUNTIME_UA)
    rememberRuntimeUserAgent('')
    expect(recordedRuntimeUserAgent()).toBeNull()
  })
})
