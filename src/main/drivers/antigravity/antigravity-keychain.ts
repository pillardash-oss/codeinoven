import { existsSync } from 'node:fs'
import { lstat, mkdir, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Logger } from '../../system/logger'

/** Where macOS keeps the login keychain, relative to the user's home. */
const MAC_KEYCHAINS_DIR = join('Library', 'Keychains')

/**
 * Give a redirected HOME its login keychain back.
 *
 * `agy` stores its OAuth credential in the macOS login keychain (its Go keyring
 * package shells out to `/usr/bin/security`), and macOS resolves that keychain
 * from `$HOME/Library/Keychains`. Every Antigravity launch CodeInOven makes
 * redirects HOME: a managed account points it at its own container, and the
 * per-turn MCP overlay points it at the turn's generated home. Under such a HOME
 * the login keychain does not exist at all, so macOS raises a "Keychain Not
 * Found" SecurityAgent alert whose only offered repair is resetting (deleting)
 * the user's keychain.
 *
 * Linking the real keychains directory into the redirected home keeps the CLI's
 * credential store working and the prompt away: `security` follows the symlink,
 * finds the same `login.keychain-db` it uses under the real home, and reads and
 * writes exactly the items it would without the overlay.
 */
export async function linkMacosLoginKeychain(
  containerHome: string,
  realHome: string = homedir()
): Promise<void> {
  if (process.platform !== 'darwin') return
  const realKeychains = join(realHome, MAC_KEYCHAINS_DIR)
  if (!existsSync(realKeychains)) return
  const linkPath = join(containerHome, MAC_KEYCHAINS_DIR)
  try {
    // A dangling symlink already occupies the path, and lstat sees it.
    await lstat(linkPath)
    return
  } catch {
    // Nothing linked yet, which is the normal case.
  }
  try {
    await mkdir(dirname(linkPath), { recursive: true })
    await symlink(realKeychains, linkPath, 'dir')
  } catch (error) {
    Logger.dev(`Antigravity login keychain could not be linked at ${linkPath}:`, error)
  }
}
