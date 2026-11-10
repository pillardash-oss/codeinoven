/**
 * CIO compatibility preamble for a browser box extension.
 *
 * WHY THIS EXISTS
 * Electron compiles out a set of `chrome.*` namespaces even when the extension
 * declares the permission, and an MV3 service worker has no other injection point:
 * `ses.registerPreloadScript({ type: 'service-worker' })` does not reach an
 * extension's worker (measured, see `.cio/tmp/sw-preload-probe`). The only way to
 * reach the worker is the file it executes, so at install time the app unzips the
 * extension into its own store and prepends this file to the extension's declared
 * `background.service_worker` entry.
 *
 * HOW THIS FILE IS BUILT
 * This is the entry of a by-concern module tree, not the injected text itself: the
 * app imports it through `?compat-bundle` and `scripts/lib/compat-source-compiler.ts`
 * bundles every module under `preamble/` into one IIFE at build time, which is what
 * gets written into the extension. Nothing here runs in the app's own process. The
 * composition below is the ORDER the original single-closure preamble ran its work
 * in, and that order is behaviour: a namespace is created before the module that
 * wraps it reads it, and the report is published last.
 *
 * RULES FOR THIS PREAMBLE
 *   1. It must never throw. A preamble that throws is worse than no preamble,
 *      because the extension's own code then never runs at all.
 *   2. It must never overwrite something that already exists. `ensure` is
 *      add-only.
 *   3. It records everything it did on `globalThis.__cioCompat`, so the app can
 *      read back what it had to fake and report it as capability loss rather than
 *      pretending the extension is whole.
 *   4. It must be valid both as a classic script and as an ES module body, because
 *      uBlock Origin Lite and 1Password declare `"background": { "service_worker":
 *      "...", "type": "module" }`. The bundle is one IIFE, and `import`
 *      declarations are hoisted, so a preamble in front of a module body is legal.
 */
import { hasChromeApi, installSurfaceCapture, state } from './context.ts'
import { installAction } from './action.ts'
import { installBridge } from './bridge.ts'
import { installBridgeCommands } from './bridge-commands.ts'
import { installContextMenus } from './context-menus.ts'
import { installContextsRepair } from './contexts.ts'
import { installCookies } from './cookies.ts'
import { installDarkReader } from './dark-reader.ts'
import { installDownloads } from './downloads.ts'
import { installEvents } from './events.ts'
import { installExtensionPage } from './extension-page.ts'
import { installMailbox } from './mailbox.ts'
import { installNamespaces } from './namespaces.ts'
import { installNativeMessaging } from './native-messaging.ts'
import { installNotifications } from './notifications.ts'
import { installPrivacy } from './privacy.ts'
import { installPublisher } from './publish.ts'
import { installRuleset } from './ruleset.ts'
import { installSidePanel } from './side-panel.ts'
import { installTabsQueryRepair } from './tabs-query.ts'
import { installUserScripts } from './user-scripts.ts'
import { installWebRequest } from './web-request.ts'
import { installWindowsTabs } from './windows-tabs.ts'

/** Run every repair, in the order the single-closure preamble ran it. */
export function installPreamble(): void {
  installSurfaceCapture()
  installDarkReader()
  installNamespaces()
  installEvents()
  installDownloads()
  installCookies()
  installWebRequest()
  installExtensionPage()
  installPrivacy()
  installNotifications()
  installSidePanel()
  installMailbox()
  installContextMenus()
  installAction()
  installBridge()
  installWindowsTabs()
  installBridgeCommands()
  installNativeMessaging()
  installRuleset()
  installContextsRepair()
  installTabsQueryRepair()
  installUserScripts()
  installPublisher()
}

if (hasChromeApi) installPreamble()
else state.errors.push('no chrome object in scope')

// The lines below are this block's own end marker. The app rewrites a stale preamble
// in an already installed copy by splitting the file at that marker, so it has to
// stay the last thing in this entry, after every module is bundled in.
// ── CIO compatibility preamble ends here ─────────────────────────────────────
