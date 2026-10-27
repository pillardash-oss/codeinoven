import { describe, expect, it } from 'vitest'
import {
  BROWSER_IDENTITY_USER_AGENT_ENV,
  browserIdentityUserAgent,
  identityUserAgentDisabled,
  recordedRuntimeUserAgent,
  rememberRuntimeUserAgent
} from '../../../src/main/browser/browser-service/browser-identity-user-agent'

const CHROME_RUNTIME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'CodeInOven/0.5.67 Chrome/152.0.7977.167 Electron/44.9.3 Safari/537.36'

describe('browser identity user agent', () => {
  it('names the environment variable that turns it off', () => {
    expect(BROWSER_IDENTITY_USER_AGENT_ENV).toBe('CODEINOVEN_BROWSER_IDENTITY_UA')
  })

  it('treats only explicit falsy spellings as the switch being off', () => {
    for (const value of ['0', 'false', 'FALSE', 'no', 'off', ' Off ']) {
      expect(identityUserAgentDisabled(value), value).toBe(true)
    }
    for (const value of [undefined, '', '1', 'true', 'yes', 'on', 'identity']) {
      expect(identityUserAgentDisabled(value), String(value)).toBe(false)
    }
  })

  it('offers the runtime user agent by default, with no variable set', () => {
    expect(browserIdentityUserAgent(undefined, CHROME_RUNTIME_UA)).toBe(CHROME_RUNTIME_UA)
    expect(browserIdentityUserAgent('1', CHROME_RUNTIME_UA)).toBe(CHROME_RUNTIME_UA)
  })

  it('offers the recorded runtime user agent verbatim, app and runtime tokens included', () => {
    expect(browserIdentityUserAgent(undefined, CHROME_RUNTIME_UA)).toContain('Electron/')
    expect(browserIdentityUserAgent(undefined, CHROME_RUNTIME_UA)).toBe(CHROME_RUNTIME_UA)
  })

  it('offers nothing when the variable turns it off', () => {
    for (const value of ['0', 'false', 'off']) {
      expect(browserIdentityUserAgent(value, CHROME_RUNTIME_UA), value).toBeNull()
    }
  })

  it('offers nothing when startup never recorded a runtime user agent', () => {
    expect(browserIdentityUserAgent(undefined, null)).toBeNull()
  })

  it('remembers a recorded user agent and refuses an empty one', () => {
    rememberRuntimeUserAgent(CHROME_RUNTIME_UA)
    expect(recordedRuntimeUserAgent()).toBe(CHROME_RUNTIME_UA)
    rememberRuntimeUserAgent('')
    expect(recordedRuntimeUserAgent()).toBeNull()
  })
})
