import { app } from 'electron'
import { isShippedBuild } from '../bootstrap/app-resources'

/**
 * Which CodeInOven build wrote one encrypted vault record.
 *
 * `safeStorage` keeps its key in the OS keyring under a service derived from the
 * app name, so the app name *is* the identity that encrypted a record: a launch
 * that reports a different name can never decrypt it. Recording the author with
 * the ciphertext is what lets an unreadable record name the build it came from
 * instead of surfacing as a bare keyring error, and it is what tells a reader
 * whether the keyring key was replaced or the record arrived from another build.
 */
export interface VaultWriterIdentity {
  /** Product name the writing launch reported, which names its keyring service. */
  app: string
  version: string
  /** A shipped build, or an unpackaged development launch. */
  build: 'installed' | 'development'
  platform: NodeJS.Platform
}

/**
 * The identity to record on a write, or `null` in a context with no Electron app
 * (a unit test, a plain script). A record without an author stays readable; it
 * simply cannot say who wrote it.
 */
export function describeVaultWriter(): VaultWriterIdentity | null {
  try {
    return {
      app: app.getName(),
      version: app.getVersion(),
      build: isShippedBuild() ? 'installed' : 'development',
      platform: process.platform
    }
  } catch {
    return null
  }
}
