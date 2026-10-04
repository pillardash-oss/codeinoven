import { platform, arch } from 'node:os'
import { OVEN_HARNESS_COMMANDS } from '../../lib/ovens'

export type Platform = NodeJS.Platform

export interface HarnessCapability {
  harnessId: string
  command: string
  supported: boolean
  unsupportedReason?: string
  installChannels?: string[]
  minNodeVersion?: string
}

export interface PlatformCapabilities {
  platform: Platform
  architecture: string
  packageManager: 'apt' | 'brew' | 'winget' | 'unknown'
  hasNode: boolean
  nodeVersion: string | null
  hasGit: boolean
  hasCurl: boolean
  supported: boolean
  harnesses: HarnessCapability[]
}

export async function detectCapabilities(): Promise<PlatformCapabilities> {
  const currentPlatform = platform()
  const currentArch = arch()
  const isWindows = currentPlatform === 'win32'
  const isMac = currentPlatform === 'darwin'
  const isLinux = currentPlatform === 'linux'

  let packageManager: PlatformCapabilities['packageManager'] = 'unknown'
  if (isMac) packageManager = 'brew'
  else if (isWindows) packageManager = 'winget'
  else if (isLinux) packageManager = 'apt'

  const harnesses: HarnessCapability[] = []
  for (const cmd of OVEN_HARNESS_COMMANDS) {
    let supported = true
    let unsupportedReason: string | undefined

    if (isWindows && cmd === 'antigravity') {
      supported = false
      unsupportedReason = 'Antigravity not supported on Windows in this release'
    }

    harnesses.push({
      harnessId: cmd,
      command: cmd,
      supported,
      unsupportedReason
    })
  }

  return {
    platform: currentPlatform,
    architecture: currentArch,
    packageManager,
    hasNode: false,
    nodeVersion: null,
    hasGit: false,
    hasCurl: false,
    supported: isLinux || isMac || isWindows,
    harnesses
  }
}
