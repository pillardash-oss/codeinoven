/**
 * The rulesets an ad blocker ships enabled and this runtime loads switched off.
 *
 * WHY THIS MODULE EXISTS
 * Electron ignores `declarative_net_request.rule_resources[].enabled`, so a copy
 * that declares its filter lists enabled installs with none of them on: uBlock
 * Origin Lite starts, reports itself healthy and blocks nothing. Only the extension
 * itself may enable a ruleset, which is why the repair runs in the worker and not
 * in the app's own process, and why the outcome is recorded on the state the
 * capability report is built from rather than logged.
 *
 * WHAT IT WILL NOT DO
 * Enable a ruleset the manifest did not declare as enabled. A copy that ships fifty
 * lists switched off would otherwise get all fifty, which is a worse outcome than
 * the defect this works around.
 */
import { chromeApi, state } from './context.ts'

/** One ruleset resource, as the extension's manifest declares it. */
interface RulesetResource {
  id: string
  enabled?: boolean
}

/** The manifest members this repair reads. */
interface RulesetManifest {
  declarative_net_request?: RulesetManifestRequest
}

/** The `declarative_net_request` block the ruleset resources hang off. */
interface RulesetManifestRequest {
  rule_resources?: RulesetResource[]
}

/** `chrome.declarativeNetRequest`, viewed through the two members it uses. */
interface RulesetApi {
  getEnabledRulesets: () => Promise<string[]>
  updateEnabledRulesets: (options: { enableRulesetIds: string[] }) => Promise<void>
}

/** The runtime namespace, viewed through the one member `getManifest` sits on. */
interface RulesetRuntime {
  getManifest?: () => RulesetManifest
}

/**
 * Enable the rulesets the manifest declares enabled, and record what changed.
 *
 * This is the place the single-closure preamble ran it in: after the native
 * messaging section, before the `getContexts` repair.
 */
export function installRuleset(): void {
  // ── The ruleset defect ──────────────────────────────────────────────────────
  // Electron ignores `declarative_net_request.rule_resources[].enabled`, so an
  // ad blocker that ships its lists enabled loads with none of them on. Only the
  // extension itself may enable them, which is why this runs here and not in main.
  const rulesApi = chromeApi.declarativeNetRequest as RulesetApi | undefined
  if (
    rulesApi &&
    typeof rulesApi.getEnabledRulesets === 'function' &&
    typeof rulesApi.updateEnabledRulesets === 'function'
  ) {
    try {
      const runtime = chromeApi.runtime as RulesetRuntime | undefined
      const manifest = runtime && runtime.getManifest ? runtime.getManifest() : {}
      // Only the rulesets the manifest declares as enabled by default. Enabling
      // every declared ruleset would hand the user fifty filter lists they opted
      // out of, which is worse than the defect being worked around.
      const dnr: RulesetManifestRequest = manifest.declarative_net_request || {}
      const declared = (dnr.rule_resources || []).filter((resource) => resource.enabled === true)
      const shouldEnable = declared.map((resource) => resource.id)
      rulesApi
        .getEnabledRulesets()
        .then((enabled) => {
          const missing = shouldEnable.filter((id) => !enabled.includes(id))
          if (!missing.length) {
            state.rulesets = {
              shouldEnable,
              enabledBefore: enabled,
              enabledAfter: enabled,
              changed: false
            }
            return
          }
          return rulesApi.updateEnabledRulesets({ enableRulesetIds: missing }).then(() =>
            rulesApi.getEnabledRulesets().then((after) => {
              state.rulesets = {
                shouldEnable,
                enabledBefore: enabled,
                enabledAfter: after,
                changed: true
              }
            })
          )
        })
        .catch((error) => {
          state.errors.push('rulesets: ' + String(error))
        })
    } catch (error) {
      state.errors.push('rulesets: ' + String(error))
    }
  }
}
