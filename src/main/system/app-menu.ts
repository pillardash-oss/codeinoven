/**
 * The application menu: the one under the app's own name on macOS.
 *
 * A production build owns its whole menu, because Electron's default one carries
 * a reload item and a DevTools item that a shipped app must not offer (neither
 * exists for the app's own window there: `devTools: !isProduction` refuses the
 * inspector and `lockDownProductionWindow` swallows both chords). A development
 * launch keeps Electron's default menu, since reload and DevTools are exactly
 * what development needs, and only has the app-specific items inserted into it.
 *
 * Windows and Linux ship without an application menu at all, so the equivalent
 * surface there is the menu bar icon's context menu
 * (`background-lifecycle-service`); the same actions are offered from both.
 */

import { Menu, MenuItem, type MenuItemConstructorOptions } from 'electron'
import { forceRestartMenuItem } from './force-restart'

/** What the menu's items do. Implemented by the composition root. */
export interface ApplicationMenuActions {
  /** The name the app menu is titled with. */
  appName: string
  /** Whether this is a production launch, which owns the entire menu. */
  production: boolean
  quitApp: () => void
  /** Check for updates, then download and install whatever is available. */
  checkForUpdates: () => void
  /** Reveal the Settings page in the app window, opening it when parked. */
  openSettings: () => void
  /** Open a second instance beside this one. */
  newInstance: () => void
}

/**
 * Settings carries the chord `keymap.json` binds to it, but never registers it.
 *
 * The renderer keymap is the one owner of that chord: registering it here would
 * make the native menu answer a key the user can rebind, so a custom binding
 * would still be shadowed by the default one. Displayed and not registered is
 * what keeps the menu honest and the keymap authoritative.
 */
const SETTINGS_ACCELERATOR = 'CommandOrControl+,'

/** The app-specific items, in the order both surfaces present them. */
function applicationItems(actions: ApplicationMenuActions): MenuItemConstructorOptions[] {
  return [
    {
      label: 'Check for Updates…',
      click: () => actions.checkForUpdates()
    },
    {
      label: 'Settings…',
      accelerator: SETTINGS_ACCELERATOR,
      registerAccelerator: false,
      click: () => actions.openSettings()
    },
    { type: 'separator' },
    {
      label: 'New Instance',
      click: () => actions.newInstance()
    },
    forceRestartMenuItem(actions.quitApp)
  ]
}

/** The full production menu: the app menus a shipped macOS app is expected to have. */
function productionTemplate(actions: ApplicationMenuActions): MenuItemConstructorOptions[] {
  return [
    {
      label: actions.appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        ...applicationItems(actions),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'windowMenu' }
  ]
}

/**
 * Insert the app-specific items into a menu Electron already installed.
 *
 * A development launch keeps its default menu, so the items are added next to
 * "About" instead of replacing the menu and taking reload, DevTools and the View
 * menu with it.
 */
function insertIntoExistingMenu(actions: ApplicationMenuActions): boolean {
  const menu = Menu.getApplicationMenu()
  const submenu = menu?.items[0]?.submenu
  if (!menu || !submenu) return false
  const aboutIndex = submenu.items.findIndex((item) => item.role === 'about')
  const insertAt = aboutIndex < 0 ? 0 : aboutIndex + 1
  const items = applicationItems(actions)
  items.forEach((item, offset) => {
    submenu.insert(insertAt + offset, new MenuItem(item))
  })
  Menu.setApplicationMenu(menu)
  return true
}

/**
 * Install the application menu for this launch.
 *
 * Only macOS has an application menu in this app; every other platform installs
 * none in production, and its equivalent actions live in the menu bar icon.
 */
export function installApplicationMenu(actions: ApplicationMenuActions): void {
  if (process.platform !== 'darwin') {
    if (actions.production) Menu.setApplicationMenu(null)
    return
  }
  if (!actions.production && insertIntoExistingMenu(actions)) return
  // A development launch with no default menu, or a production launch: build it.
  Menu.setApplicationMenu(Menu.buildFromTemplate(productionTemplate(actions)))
}
