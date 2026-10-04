import { platform } from 'node:os'

export interface BootstrapResult {
  platform: NodeJS.Platform
  ready: boolean
  needsNodeInstall: boolean
  message?: string
}

export async function bootstrapPlatform(): Promise<BootstrapResult> {
  const currentPlatform = platform()
  return {
    platform: currentPlatform,
    ready: true,
    needsNodeInstall: false
  }
}
