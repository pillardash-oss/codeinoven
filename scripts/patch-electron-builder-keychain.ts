#!/usr/bin/env bun
/**
 * Patch app-builder-lib's macOS keychain setup so `security
 * set-key-partition-list` receives the temporary keychain's own password
 * instead of the .p12 import password (CSC_KEY_PASSWORD).
 *
 * Upstream bug: `createKeychain()` (macCodeSign.js) creates and unlocks the
 * keychain with a random 32-byte base64 password, but `importCerts()` then
 * runs `set-key-partition-list -k <certPassword>`. That flag authenticates
 * against the keychain itself, so on newer macOS `security` builds (macOS 26
 * runners, local macOS 26) it fails hard with
 * `SecKeychainUnlock: The user name or passphrase you entered is not correct.`
 * and every CSC_LINK-based macOS build dies before codesign runs.
 *
 * Fixed upstream in master (electron-builder#10101, v27 alphas) and backported
 * to the v26 branch (electron-builder#10172), but no release containing it has
 * shipped yet (app-builder-lib 26.16.0 still has the bug). Once a fixed
 * version is published, remove this patch and delete the call from the
 * postinstall script in package.json.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const macCodeSignPath = resolve(import.meta.dirname ?? '.', '../node_modules/app-builder-lib/out/codeSign/macCodeSign.js')

if (!existsSync(macCodeSignPath)) {
  process.stdout.write('[patch-electron-builder-keychain] app-builder-lib not installed; skipping\n')
  process.exit(0)
}

const original = readFileSync(macCodeSignPath, 'utf8')

const buggy =
  'await (0, builder_util_1.exec)("/usr/bin/security", ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]);'

const fixed =
  'await (0, builder_util_1.exec)("/usr/bin/security", ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", keychainPassword, keychainFile]);'

// Upstream fix (electron-builder#10101): thread the keychain's own password
// into importCerts and use it for set-key-partition-list.
const patched = original.replace(buggy, fixed)

if (patched === original) {
  if (original.includes('"-k", keychainPassword')) {
    process.stdout.write('[patch-electron-builder-keychain] already patched\n')
  } else {
    process.stdout.write('[patch-electron-builder-keychain] target line not found (upstream may have fixed it); no changes made\n')
  }
  process.exit(0)
}

// importCerts is called from createKeychain, which owns the random
// keychainPassword. Rewrite the signature/call chain to pass it through.
let result = patched

const callBefore = 'return await importCerts(keychainFile, certPaths, cscPasswords);'
const callAfter = 'return await importCerts(keychainFile, certPaths, cscPasswords, keychainPassword);'
if (!result.includes(callBefore)) {
  process.stdout.write('[patch-electron-builder-keychain] importCerts call site not found; aborting without changes\n')
  process.exit(1)
}
result = result.replace(callBefore, callAfter)

const sigBefore = 'async function importCerts(keychainFile, paths, keyPasswords) {'
const sigAfter = 'async function importCerts(keychainFile, paths, keyPasswords, keychainPassword) {'
if (!result.includes(sigBefore)) {
  process.stdout.write('[patch-electron-builder-keychain] importCerts signature not found; aborting without changes\n')
  process.exit(1)
}
result = result.replace(sigBefore, sigAfter)

if (!result.includes('"-k", keychainPassword')) {
  process.stdout.write('[patch-electron-builder-keychain] patch did not apply cleanly; aborting without changes\n')
  process.exit(1)
}

writeFileSync(macCodeSignPath, result, 'utf8')
process.stdout.write('[patch-electron-builder-keychain] patched set-key-partition-list to use the keychain password\n')
