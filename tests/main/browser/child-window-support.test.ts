import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setMainBundleDirectory } from '../../../src/main/bootstrap/bundle-directory'

const electron = vi.hoisted(() => ({
  app: { isPackaged: false },
  nativeTheme: { shouldUseDarkColors: true }
}))
const exists = vi.hoisted(() => vi.fn<(path: string) => boolean>())
vi.mock('electron', () => electron)
vi.mock('node:fs', () => ({ existsSync: exists }))
import {
  loadRendererDocument,
  resolveChildWindowPreload
} from '../../../src/main/browser/child-window-support'

const output = resolve('.cio/tmp/native-overlay-tests/out')
setMainBundleDirectory(pathToFileURL(resolve(output, 'main/index.js')).href)

afterEach(() => {
  vi.unstubAllEnvs()
  exists.mockReset()
  electron.app.isPackaged = false
})

describe('child window assets', () => {
  it.each(['index.mjs', 'index.js', 'index.cjs'])(
    'resolves %s beside the main entry even when support code is chunked',
    (name) => {
      const expected = resolve(output, 'preload', name)
      exists.mockImplementation((path) => path === expected)
      expect(resolveChildWindowPreload()).toBe(expected)
    }
  )

  it('loads packaged modal and toast documents from the entry renderer directory', async () => {
    electron.app.isPackaged = true
    const target = {
      loadURL: vi.fn().mockResolvedValue(undefined),
      loadFile: vi.fn().mockResolvedValue(undefined)
    }
    await loadRendererDocument(target, 'browser-overlay.html', { surface: 'toasts', theme: 'dark' })
    expect(target.loadFile).toHaveBeenCalledWith(resolve(output, 'renderer/browser-overlay.html'), {
      query: { surface: 'toasts', theme: 'dark' }
    })
    expect(target.loadURL).not.toHaveBeenCalled()
  })

  it('loads development overlays with their exact surface and theme', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:6267')
    const target = {
      loadURL: vi.fn().mockResolvedValue(undefined),
      loadFile: vi.fn().mockResolvedValue(undefined)
    }
    await loadRendererDocument(target, 'browser-overlay.html', { surface: 'strip', theme: 'light' })
    expect(target.loadURL).toHaveBeenCalledWith(
      'http://localhost:6267/browser-overlay.html?surface=strip&theme=light'
    )
    expect(target.loadFile).not.toHaveBeenCalled()
  })
})
