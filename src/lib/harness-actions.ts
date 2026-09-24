import type { ProviderConnectionInfo } from './types'

/**
 * Harness states in which CodeInOven holds something it can act on: the harness
 * resolved on this machine and owns a transport.
 *
 * `error` is deliberately included, and it is the reason the uninstall
 * predicate exists. A harness lands in `error` when its binary resolves but the
 * version probe never answers   the signature of a *broken install* (macOS
 * SIGKILLs an executable whose code signature no longer matches its contents
 * during exec, so the process dies before it prints a byte). Gating the
 * lifecycle actions on `available` alone therefore hid them in exactly the
 * state that needs them, while the driver's own failure message told the user
 * to "reinstall it under Settings, Harnesses".
 *
 * `not_found` is excluded on purpose: with no resolved binary the documented
 * removal commands would delete config and data (`rm -rf ~/.cline`) instead of
 * removing an install, which is not an uninstall, and there is no transport to
 * restart either.
 */
const LIVE_INSTALL_STATUSES: readonly ProviderConnectionInfo['status'][] = ['available', 'error']

/**
 * True when CodeInOven can hand the user a harness's own documented removal
 * command for this row. Bundled harnesses ship inside the app binary, so they
 * are never removed separately.
 */
export function canUninstallHarness(
  provider: Pick<ProviderConnectionInfo, 'status' | 'executionTarget'>
): boolean {
  if (provider.executionTarget?.kind === 'bundled') return false
  return LIVE_INSTALL_STATUSES.includes(provider.status)
}

/**
 * True when CodeInOven owns a transport it can restart for this row.
 *
 * Restarting is what makes a harness's self-update take effect: the CLI on disk
 * changes, but a resident process (OpenCode's `serve`, Codex's app-server, Pi's
 * per-session RPC client) keeps the old build alive until the app quits. Unlike
 * uninstall, a bundled harness is restartable   Pi's RPC sessions are
 * CodeInOven's own processes   so only the resolved-install requirement
 * applies.
 */
export function canRestartHarness(
  provider: Pick<ProviderConnectionInfo, 'status' | 'integration'>
): boolean {
  if (provider.integration !== 'ready') return false
  return LIVE_INSTALL_STATUSES.includes(provider.status)
}
