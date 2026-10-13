/// <reference types="electron-vite/node" />
import { BrowserWindow } from 'electron'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join, relative, isAbsolute, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import createExportWorker from './design-export-worker.ts?nodeWorker'
import { listDesignScreens } from './design-screens'
import { resolveServedFolder, resolveServedEntry, servedFileUrl } from '../preview/served-folder'
import type { DirectoryPreviewService } from '../preview/directory-preview-service'
import type { DesignExportFormat, DesignExportResult } from '../../lib/design/design-export'
import { isScreenCanvasEntry } from '../../lib/design/screen-canvas'

let exporting = false

/** One bounded export at a time. PDF layout and printing run in a separate renderer. */
export async function exportDesign(
  projectRoot: string,
  directory: unknown,
  entry: unknown,
  format: DesignExportFormat,
  previews: DirectoryPreviewService
): Promise<DesignExportResult> {
  if (exporting) throw new Error('Another design export is running. Try again when it finishes.')
  exporting = true
  try {
    const folder = resolveServedFolder(projectRoot, directory, '.cio/designs')
    const canonicalRoot = await realpath(projectRoot)
    const canonicalFolder = await realpath(folder.absolute)
    const inside = relative(canonicalRoot, canonicalFolder)
    if (inside.startsWith('..') || isAbsolute(inside))
      throw new Error('Design folder escapes the project')
    const selected = entry == null ? null : await resolveServedEntry(canonicalFolder, entry)
    const entries = selected
      ? [selected.requested]
      : (await listDesignScreens(canonicalFolder))
          .filter((screen) => format === 'zip' || !isScreenCanvasEntry(screen.entry))
          .map((screen) => screen.entry)
    if (!entries.length) throw new Error('This design has no screens to export')
    const outputRelative = `.cio/work/design-exports/${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`
    const output = join(projectRoot, outputRelative)
    await mkdir(output, { recursive: true })
    let files: string[]
    if (format === 'pdf') {
      const registration = await previews.open(canonicalFolder)
      const window = new BrowserWindow({
        show: false,
        width: 1440,
        height: 900,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
          partition: 'design-export'
        }
      })
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', (event) => event.preventDefault())
      try {
        files = []
        for (const page of entries) {
          const resolved = await resolveServedEntry(canonicalFolder, page)
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              (async () => {
                await window.loadURL(servedFileUrl(registration.url, resolved))
                await window.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
                const pdf = await window.webContents.printToPDF({
                  printBackground: true,
                  preferCSSPageSize: true
                })
                if (pdf.byteLength > 64 * 1024 * 1024) throw new Error('PDF exceeds 64 MiB')
                const name = page.replace(/\.html$/iu, '.pdf')
                await mkdir(dirname(join(output, name)), { recursive: true })
                await writeFile(join(output, name), pdf)
                files.push(name)
              })(),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error(`PDF rendering timed out for ${page}`)),
                  30_000
                )
              })
            ])
          } finally {
            clearTimeout(timer)
          }
        }
      } finally {
        window.destroy()
      }
    } else {
      files = await new Promise<string[]>((resolve, reject) => {
        const worker = createExportWorker({
          workerData: { root: canonicalFolder, output, entries, format }
        })
        let settled = false
        const finish = (error: Error | null, result: string[] = []): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          void worker.terminate()
          if (error) reject(error)
          else resolve(result)
        }
        const timer = setTimeout(() => finish(new Error('Design export timed out')), 120_000)
        worker.on('message', (message: { type: string; files?: string[]; message?: string }) => {
          if (message.type === 'result') finish(null, message.files)
          else if (message.type === 'error') finish(new Error(message.message))
        })
        worker.on('error', (error: Error) => finish(error))
        worker.on('exit', (code: number) => {
          if (!settled) finish(new Error(`Export worker stopped with exit ${code}`))
        })
      })
    }
    return { directory: outputRelative, files }
  } finally {
    exporting = false
  }
}
