/**
 * `chrome.privacy`, as an honest reader.
 *
 * WHY THIS EXISTS
 * `chrome.privacy` is read while an extension's module graph evaluates, not on
 * demand: uBlock Origin classic touches `networkPredictionEnabled` and
 * `hyperlinkAuditingEnabled` as its own modules run, and Electron compiles the whole
 * namespace out, so there was nothing there to read and the extension died before it
 * could filter anything (measured, see `.cio/work/browser-containers/plan.md`).
 *
 * WHAT IT CAN HONESTLY BE
 * A reader. The app does not gate network prediction, hyperlink auditing or WebRTC
 * policy on an extension's say-so, so these settings report `not_controllable` rather
 * than claim a control nobody wired up, and every `set` or `clear` is counted in
 * `state.privacy.inertCalls` so the install-time capability report can say the
 * setting was read-only instead of reporting the namespace as present and whole.
 * `set` still resolves rather than rejects: an extension that tries is better off
 * carrying on with a setting that does nothing than being thrown out of its own
 * startup path.
 *
 * Values are Chromium's own defaults for a profile with no policy, which is what an
 * extension expects to read in a browser nobody has configured.
 */
import { answerWith, roots, state } from './context.ts'
import type { ChromeNamespace } from './context.ts'
import { makeRealEvent } from './events.ts'
import type { RealEvent } from './events.ts'

/** The defaults an unconfigured Chromium profile reports, per area. */
const privacyDefaults: Record<string, Record<string, unknown>> = {
  network: {
    networkPredictionEnabled: true,
    webRTCIPHandlingPolicy: 'default_public_interface_only'
  },
  services: {
    alternateErrorPagesEnabled: true,
    autofillAddressEnabled: true,
    autofillCreditCardEnabled: true,
    passwordSavingEnabled: true,
    safeBrowsingEnabled: true,
    searchSuggestEnabled: true,
    spellingServiceEnabled: true,
    translationServiceEnabled: true
  },
  websites: {
    thirdPartyCookiesAllowed: true,
    referrersEnabled: true,
    hyperlinkAuditingEnabled: true,
    protectedContentEnabled: true
  }
}

/** What one setting reports when it is read. */
interface PrivacyValue {
  value: unknown
  levelOfControl: string
  incognitoSpecific: boolean
}

/** One setting, with the dual callback/promise surface Chrome documents. */
interface PrivacySetting {
  get: (details: unknown, callback: unknown) => Promise<unknown>
  set: (details: unknown, callback: unknown) => Promise<unknown>
  clear: (details: unknown, callback: unknown) => Promise<unknown>
  onChange: RealEvent
}

/** What the capability report says about this namespace. */
interface PrivacyReport {
  settings: string[]
  inertCalls: number
  areas: string[]
  lastCall?: unknown
}

/** The typed view of the report this module keeps on `state`. */
function privacyReport(): PrivacyReport {
  const existing = state['privacy'] as PrivacyReport | undefined
  if (existing) return existing
  const created: PrivacyReport = { settings: [], inertCalls: 0, areas: [] }
  state['privacy'] = created
  return created
}

/** One setting that remembers the last value it was told, and counts the rest. */
function makePrivacySetting(initial: unknown): PrivacySetting {
  const onChange = makeRealEvent()
  let value = initial
  const read = (): PrivacyValue => ({
    value,
    // Not a claim about the value, a claim about who can change it. The app
    // does not act on any of these, so saying otherwise would be a lie an
    // extension could plan around.
    levelOfControl: 'not_controllable',
    incognitoSpecific: false
  })
  const note = (call: string): void => {
    const report = privacyReport()
    report.inertCalls += 1
    report.lastCall = call
  }
  // Chrome's dual callback/promise surface, shared with the other shims.
  const answer = answerWith
  return {
    get: (details, callback) => {
      try {
        return answer(callback, read())
      } catch (error) {
        state.errors.push('privacy-get: ' + String(error))
        return Promise.resolve(read())
      }
    },
    set: (details, callback) => {
      try {
        const record =
          details && typeof details === 'object' ? (details as Record<string, unknown>) : {}
        const next = 'value' in record ? record['value'] : undefined
        // The value is kept in this life so a read after a write does not
        // contradict what the extension was just told, even though the app is
        // not acting on it.
        if (next !== undefined && next !== value) {
          value = next
          onChange.__cioEmit([{ value }])
        }
        note('set')
        return answer(callback, undefined)
      } catch (error) {
        state.errors.push('privacy-set: ' + String(error))
        return Promise.resolve()
      }
    },
    clear: (details, callback) => {
      try {
        // Back to the default this shim started from, which is what clearing a
        // setting means when nobody else has set it.
        value = initial
        note('clear')
        return answer(callback, undefined)
      } catch (error) {
        state.errors.push('privacy-clear: ' + String(error))
        return Promise.resolve()
      }
    },
    onChange
  }
}

/** Install one shared set of settings on every root that lacks one. */
export function installPrivacy(): void {
  const report = privacyReport()
  const privacyAreas: Record<string, unknown> = {}
  for (const areaName of Object.keys(privacyDefaults)) {
    const area: Record<string, unknown> = {}
    for (const settingName of Object.keys(privacyDefaults[areaName] as Record<string, unknown>)) {
      // Enumerable, because Chromium's own API objects are: an extension that
      // discovers capability by iterating sees nothing of a non-enumerable one.
      Object.defineProperty(area, settingName, {
        value: makePrivacySetting(
          (privacyDefaults[areaName] as Record<string, unknown>)[settingName]
        ),
        configurable: true,
        writable: true,
        enumerable: true
      })
      report.settings.push(areaName + '.' + settingName)
    }
    Object.defineProperty(privacyAreas, areaName, {
      value: area,
      configurable: true,
      writable: true,
      enumerable: true
    })
    report.areas.push(areaName)
  }
  for (const root of roots) {
    try {
      if (!root) continue
      const existing = root['privacy'] as ChromeNamespace | undefined
      if (existing && typeof existing === 'object') {
        // Add-only, so a runtime that ever compiles part of this in is not
        // overwritten. Nothing here is enumerable-breaking: a setting that is
        // already there is left exactly as the runtime made it.
        for (const areaName of Object.keys(privacyAreas)) {
          const present = existing[areaName]
          if (!present || typeof present !== 'object') {
            Object.defineProperty(existing, areaName, {
              value: privacyAreas[areaName],
              configurable: true,
              writable: true,
              enumerable: true
            })
          }
        }
        continue
      }
      Object.defineProperty(root, 'privacy', {
        value: privacyAreas,
        configurable: true,
        writable: true,
        enumerable: true
      })
    } catch (error) {
      state.errors.push('privacy: ' + String(error))
    }
  }
}
