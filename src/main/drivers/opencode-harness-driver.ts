import { OPENCODE_COMMAND, isOpenCodeV2Version } from '../../lib/opencode-version'
import { cachedOpenCodeInstallation } from '../agents/opencode-installation'
import type { BaseUrlProviderService } from '../providers/base-url-provider-service'
import type { SecretVault } from '../storage/secret-vault'
import type { HarnessDriver } from './driver.interface'
import { OpenCodeDriver } from './opencode-driver'
import { OpenCodeV2Driver } from './opencode-v2-driver'

/**
 * Build the driver for the single `opencode` harness.
 *
 * V1 and V2 both install as `opencode` but speak different server APIs, so the
 * transport is chosen from the detected install: V2 when the newest probed
 * `opencode`/`opencode2` reports major >= 2, V1 otherwise. The resolved command
 * is passed through so either transport spawns the binary that answered the
 * probe. The user never selects a version.
 */
export function createOpenCodeHarnessDriver(
  baseUrlProviders?: BaseUrlProviderService,
  secretVault?: SecretVault,
  accountEnvironment: NodeJS.ProcessEnv = {}
): HarnessDriver {
  const installation = cachedOpenCodeInstallation()
  const command = installation?.command ?? OPENCODE_COMMAND
  if (installation && isOpenCodeV2Version(installation.version)) {
    return new OpenCodeV2Driver(baseUrlProviders, secretVault, accountEnvironment, command)
  }
  return new OpenCodeDriver(baseUrlProviders, secretVault, accountEnvironment, command)
}

/** True when the detected OpenCode install drives the V2 transport. */
export function isOpenCodeV2Installed(): boolean {
  const installation = cachedOpenCodeInstallation()
  return installation !== null && isOpenCodeV2Version(installation.version)
}
