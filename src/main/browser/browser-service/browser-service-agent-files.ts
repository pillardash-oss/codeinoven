import { agentDialog } from '../../system/file-dialogs'
import { nativeImage, type NativeImage } from 'electron'
import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import type { PermissionLevel } from '../../../lib/types'
import { fitWithin, MAX_SCREENSHOT_DIMENSION } from '../../../lib/image-payload'
import { agentElementRectScript } from './browser-agent-page'
import { Logger } from '../../system/logger'
import { type BrowserTab } from './browser-types'
import { SCREENSHOT_JPEG_QUALITY, SCREENSHOT_MAX_BYTES } from './browser-validation'
import type { BrowserService } from '../browser-service'
import { asObject, safeOrigin } from './browser-service-common'

/**
 * Files an agent moves in and out of a page: uploads and captures.
 *
 * An upload is either a native file chooser the user completes or an exact file the
 * agent named, and a capture is the page's own pixels sized to what a model can read.
 * Both are file-system work driven from a page, so both live here, apart from the
 * operation switch that calls them.
 */

/**
 * What `browser-service-agent-files` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface AgentFilesHost {
  readonly lastScreenshot: BrowserService['lastScreenshot']
  readonly optionalAgentSelector: BrowserService['optionalAgentSelector']
  readonly runAgentScript: BrowserService['runAgentScript']
  readonly window: BrowserService['window']
}

export function fileChooserFilters(accept: string): Array<{ name: string; extensions: string[] }> {
  const extensions = [
    ...new Set(
      accept
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.startsWith('.') && !item.includes('*'))
        .map((item) => item.slice(1).toLowerCase())
        .filter((item) => /^[a-z0-9.+_-]+$/u.test(item))
    )
  ]
  return extensions.length > 0 ? [{ name: 'Accepted file types', extensions }] : []
}

export class BrowserServiceAgentFiles {
  constructor(private readonly host: AgentFilesHost) {}

  /**
   * Fill a page's file input through a narrow main-process action. Auto Review
   * always asks the user to choose files in a native dialog; Full Access can use
   * paths directly. The site never receives a file until this operation is
   * called, and this operation never submits the surrounding form.
   */
  async uploadFiles(
    tabId: string,
    tab: BrowserTab,
    input: Record<string, unknown>,
    permissionLevel: PermissionLevel | undefined
  ): Promise<Record<string, unknown>> {
    const contents = tab.view.webContents
    if (contents.isDestroyed()) throw new Error('The browser page is no longer available')

    const selector = this.host.optionalAgentSelector(input) ?? 'input[type="file"]'
    const beforeUrl = contents.getURL()
    const beforeGeneration = tab.navigationGeneration
    const inputState: unknown = await contents.executeJavaScript(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLInputElement) || element.type !== 'file') {
        return { available: false };
      }
      return {
        available: true,
        multiple: element.multiple,
        accept: element.accept,
        disabled: element.disabled
      };
    })()`)
    if (typeof inputState !== 'object' || inputState === null) {
      throw new Error('The selected browser element is not a file input')
    }
    const inputRecord = inputState as Record<string, unknown>
    if (inputRecord['available'] !== true || inputRecord['disabled'] === true) {
      throw new Error('The selected browser element is not an enabled file input')
    }
    const multiple = inputRecord['multiple'] === true
    const accept = typeof inputRecord['accept'] === 'string' ? inputRecord['accept'] : ''
    const requestedPaths = this.uploadPathInputs(input)
    const suppliedPaths = permissionLevel === 'full_access' ? requestedPaths : []
    let paths: string[]
    if (suppliedPaths.length > 0) {
      paths = await Promise.all(suppliedPaths.map((path) => this.resolveUploadPath(path)))
      if (!multiple && paths.length > 1) {
        throw new Error('This file input accepts one file at a time')
      }
    } else {
      const filters = fileChooserFilters(accept)
      const choice = await agentDialog.showOpenDialog(this.host.window, {
        title: `Choose files for upload to ${safeOrigin(beforeUrl)}`,
        buttonLabel: 'Upload',
        properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
        ...(filters.length > 0 ? { filters } : {})
      })
      if (choice.canceled || choice.filePaths.length === 0) {
        return { uploaded: false, cancelled: true }
      }
      paths = await Promise.all(choice.filePaths.map((path) => this.resolveUploadPath(path)))
    }
    if (paths.length > 10) throw new Error('A browser upload can include at most 10 files')

    if (
      contents.isDestroyed() ||
      tab.navigationGeneration !== beforeGeneration ||
      contents.getURL() !== beforeUrl
    ) {
      throw new Error(
        'The page changed while the file upload was being approved; retry on the current page'
      )
    }

    const debuggerSession = contents.debugger
    const attachedHere = !debuggerSession.isAttached()
    try {
      if (attachedHere) debuggerSession.attach('1.3')
      const documentResult: unknown = await debuggerSession.sendCommand('DOM.getDocument', {
        depth: 1,
        pierce: true
      })
      const documentRecord = asObject(documentResult)
      const root = asObject(documentRecord?.['root'])
      const rootNodeId = root?.['nodeId']
      if (typeof rootNodeId !== 'number') throw new Error('The page document is unavailable')
      const queryResult: unknown = await debuggerSession.sendCommand('DOM.querySelector', {
        nodeId: rootNodeId,
        selector
      })
      const nodeId = asObject(queryResult)?.['nodeId']
      if (typeof nodeId !== 'number' || nodeId === 0) {
        throw new Error('The file input is no longer present on the page')
      }
      await debuggerSession.sendCommand('DOM.setFileInputFiles', { nodeId, files: paths })
      return { uploaded: true, files: paths.map((path) => basename(path)), submitted: false }
    } finally {
      if (attachedHere && debuggerSession.isAttached()) debuggerSession.detach()
    }
  }

  uploadPathInputs(input: Record<string, unknown>): string[] {
    const value = input['paths']
    if (value === undefined) return []
    if (
      !Array.isArray(value) ||
      value.length < 1 ||
      value.length > 10 ||
      value.some((path) => typeof path !== 'string' || path.length === 0 || path.length > 8192)
    ) {
      throw new TypeError('paths must contain between 1 and 10 absolute file paths')
    }
    return value as string[]
  }

  async resolveUploadPath(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new TypeError('Every upload path must be absolute')
    const resolved = await realpath(path)
    const details = await stat(resolved)
    if (!details.isFile()) throw new TypeError(`Upload path is not a file: ${basename(path)}`)
    return resolved
  }

  /**
   * Capture a tab's page for an agent at a size the model can afford.
   *
   * `capturePage` returns device pixels, so a 4K panel yields a 3840x2160 picture
   * and a requested viewport may reach `MAX_VIEWPORT_SIDE`, doubled again by the
   * display scale factor. Base64 that travels inline in a tool result is billed as
   * text, at roughly one token per character, which measured ~40,788 tokens for one
   * such capture; the same picture sent as an image content part is billed on its
   * pixels instead, which is why the gateway converts it. The capture is therefore
   * capped to a legible size, bounded in bytes for a photo-heavy page, and skipped
   * entirely when the page has not changed, because a design thread was measured
   * taking seven byte-identical screenshots in a single turn.
   */
  async captureScreenshot(
    tabId: string,
    tab: BrowserTab,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const captured = await this.captureAgentImage(tab, input)
    const source = captured.getSize()
    const target = fitWithin(source.width, source.height, MAX_SCREENSHOT_DIMENSION)
    const capped = target.width !== source.width || target.height !== source.height
    const resized = capped
      ? captured.resize({ width: target.width, height: target.height })
      : captured
    const png = resized.toPNG()
    const lossless = png.byteLength <= SCREENSHOT_MAX_BYTES
    const encoded = lossless ? png : resized.toJPEG(SCREENSHOT_JPEG_QUALITY)
    const hash = createHash('sha256').update(encoded).digest('hex')
    // One capture record per target: a full-page capture must not be reported as
    // unchanged because the viewport happened to look the same a moment ago.
    const captureKey = `${tabId}:${this.host.optionalAgentSelector(input) ?? (input['fullPage'] === true ? 'page' : 'viewport')}`
    if (input['force'] !== true && this.host.lastScreenshot.get(captureKey)?.hash === hash) {
      return {
        unchanged: true,
        width: target.width,
        height: target.height,
        detail:
          'The page has not changed since the previous screenshot, so it was not captured again. Pass {"force":true} to capture it anyway.'
      }
    }
    this.host.lastScreenshot.set(captureKey, { hash, width: target.width, height: target.height })
    return {
      dataUrl: `data:image/${lossless ? 'png' : 'jpeg'};base64,${encoded.toString('base64')}`,
      width: target.width,
      height: target.height,
      // Report the render size only when it was capped, so a model reading a
      // screenshot knows the page it is reviewing was laid out larger.
      ...(capped ? { sourceWidth: source.width, sourceHeight: source.height } : {})
    }
  }

  /**
   * The pixels one screenshot asks for: the viewport, the whole page, or one
   * element.
   *
   * `capturePage` only ever gives the visible viewport, which is not enough for a
   * long page an agent has to read, so a full-page or element capture goes through
   * the debugger's own `Page.captureScreenshot`, which paints beyond the viewport
   * and clips to a page rectangle. Both fall back to the viewport capture when the
   * debugger cannot answer, because a smaller picture beats no picture.
   */
  async captureAgentImage(tab: BrowserTab, input: Record<string, unknown>): Promise<NativeImage> {
    const contents = tab.view.webContents
    if (contents.isDestroyed()) throw new Error('The browser page is no longer available')
    const selector = this.host.optionalAgentSelector(input)
    const fullPage = input['fullPage'] === true
    if (!selector && !fullPage) return contents.capturePage()
    const debuggerSession = contents.debugger
    const attachedHere = !debuggerSession.isAttached()
    try {
      if (attachedHere) debuggerSession.attach('1.3')
      await debuggerSession.sendCommand('Page.enable').catch(() => undefined)
      let clip: { x: number; y: number; width: number; height: number; scale: number }
      if (selector) {
        const rect = asObject(
          await this.host.runAgentScript(contents, agentElementRectScript(selector))
        )
        if (!rect) throw new Error('the element could not be measured')
        clip = {
          x: Number(rect['x']),
          y: Number(rect['y']),
          width: Number(rect['width']),
          height: Number(rect['height']),
          scale: 1
        }
      } else {
        const metrics = asObject(await debuggerSession.sendCommand('Page.getLayoutMetrics'))
        const size = asObject(metrics?.['cssContentSize']) ?? asObject(metrics?.['contentSize'])
        if (!size) throw new Error('the page size is unavailable')
        clip = {
          x: 0,
          y: 0,
          width: Number(size['width']),
          height: Number(size['height']),
          scale: 1
        }
      }
      const captured = asObject(
        await debuggerSession.sendCommand('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip
        })
      )
      const data = typeof captured?.['data'] === 'string' ? captured['data'] : ''
      if (data.length === 0) throw new Error('the capture returned no image')
      const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'))
      return image.isEmpty() ? contents.capturePage() : image
    } catch (error) {
      Logger.dev('A full-page browser capture fell back to the viewport:', error)
      return contents.capturePage()
    } finally {
      if (attachedHere && debuggerSession.isAttached()) debuggerSession.detach()
    }
  }
}
