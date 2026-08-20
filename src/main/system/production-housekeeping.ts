import { Menu, type MenuItemConstructorOptions } from 'electron'

/** The standard View menu restored in production so users can open developer
 *  tools, reload, zoom, and toggle fullscreen from the application menu. */
function viewMenuTemplate(): MenuItemConstructorOptions {
  return {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { type: 'separator' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  }
}

/**
 * Application menu for production. macOS keeps the required app menu while
 * Windows/Linux regain a full menu bar; every platform gets the standard View
 * menu (developer tools, reload, zoom, fullscreen) back so users can open the
 * developer option and adjust the view.
 */
export function installProductionApplicationMenu(appName: string): void {
  const viewMenu = viewMenuTemplate()

  if (process.platform !== 'darwin') {
    const template: MenuItemConstructorOptions[] = [
      {
        label: 'File',
        submenu: [{ role: 'quit' }]
      },
      { role: 'editMenu' },
      viewMenu,
      { role: 'windowMenu' }
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
    return
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: appName,
      submenu: [
        { role: 'about' },
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
    viewMenu,
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
