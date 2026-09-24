import type { ProviderConnectionInfo } from './types'

/**
 * Harness states in which there is something on this machine worth removing.
 *
 * `error` is deliberately included, and it is the reason this predicate exists.
 * A harness lands in `error` when its binary resolves but the version probe
 * never answers   the signature of a *broken install* (macOS SIGKILLs an
 * executable whose code signature no longer matches its contents during exec,
 * so the process dies before it prints a byte). Gating uninstall on `available`
 * alone therefore hid the removal action in exactly the state that needs it,
 * while the driver's own failure message told the user to "reinstall it under
 * Settings, Harnesses".
 *
 * `not_found` is excluded on purpose: with no resolved binary the documented
 * removal commands would delete config and data (`rm -rf ~/.cline`) instead of
 * removing an install, which is not an uninstall.
 */
const UNINSTALLABLE_STATUSES: readonly ProviderConnectionInfo['status'][] = ['available', 'error']

/**
 * True when CodeInOven can hand the user a harness's own documented removal
 * command for this row. Bundled harnesses ship inside the app binary, so they
 * are never removed separately.
 */
export function canUninstallHarness(
  provider: Pick<ProviderConnectionInfo, 'status' | 'executionTarget'>
): boolean {
  if (provider.executionTarget?.kind === 'bundled') return false
  return UNINSTALLABLE_STATUSES.includes(provider.status)
}
