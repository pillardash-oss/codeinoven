import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the rule that every launch sharing one config root reports one app name.
 *
 * `safeStorage` keeps its key in the OS keyring under `<app name> Safe Storage`,
 * so the app name *is* the key identity that encrypts the credential vault. A
 * development launch that named itself `Electron` therefore held a different key
 * than the installed app while both shared `~/.config/pillardash/codeinoven`,
 * and whichever build wrote a vault record, the other read it as signed out
 * (`github:authStatus` failed with "Error while decrypting the ciphertext
 * provided to safeStorage.decryptString" on every sidebar poll, 2026-10-19).
 *
 * Development and packaged Chromium data are already kept apart by
 * `configureElectronDataRoot`, so nothing needs the runtime's own name.
 */
describe('the launch name is the credential vault keyring identity', () => {
  const indexSource = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

  it('names the app after the product, never after the runtime', () => {
    const call = /app\.setName\(([^)]*)\)/u.exec(indexSource)

    expect(call, 'src/main/index.ts must name the app before the first window').not.toBeNull()
    expect(call?.[1]?.trim()).toBe('APP_NAME')
  })

  it('declares no second, runtime-named identity', () => {
    expect(indexSource).not.toContain("'Electron'")
    expect(indexSource).not.toContain('"Electron"')
  })
})
