import { parentPort, workerData } from 'node:worker_threads'
import { readFile, readdir, stat, realpath, mkdir, writeFile } from 'node:fs/promises'
import { join, dirname, relative, resolve, isAbsolute } from 'node:path'
import JSZip from 'jszip'
import { mimeTypeForPath } from '../../lib/mime-types'
import type { DesignExportFormat } from '../../lib/design/design-export'
import { screenCanvasRuntimeScript, screenCanvasRuntimeStyle } from './screen-canvas-runtime'
import { designTweaksRuntimeScript } from './design-tweaks-runtime'
import { isScreenCanvasEntry } from '../../lib/design/screen-canvas'

export interface ExportWorkerRequest {
  root: string
  output: string
  entries: string[]
  format: Exclude<DesignExportFormat, 'pdf'>
}

/** Resource reads and archive compression happen only in this bounded worker. */
export async function exportDesignFiles(request: ExportWorkerRequest): Promise<string[]> {
  const root = await realpath(request.root)
  let bytes = 0
  let count = 0
  const read = async (path: string): Promise<Buffer> => {
    const canonical = await realpath(path)
    const within = relative(root, canonical)
    if (within.startsWith('..') || isAbsolute(within))
      throw new Error('Export asset escapes the design folder')
    const info = await stat(canonical)
    bytes += info.size
    count++
    if (info.size > 16 * 1024 * 1024 || bytes > 64 * 1024 * 1024 || count > 2000) {
      throw new Error('Design export exceeds the resource limit of 64 MiB or 2000 reads')
    }
    return readFile(canonical)
  }
  const assetPath = (reference: string, source: string): string => {
    if (/^(?:https?:|\/\/|file:|javascript:)/iu.test(reference))
      throw new Error(`Export needs a local asset: ${reference}`)
    const path = decodeURIComponent(reference.split(/[?#]/u)[0] ?? '')
    return resolve(reference.startsWith('/') ? root : dirname(source), path.replace(/^\//u, ''))
  }
  const replaceAsync = async (
    text: string,
    regex: RegExp,
    replacer: (match: RegExpMatchArray) => Promise<string>
  ): Promise<string> => {
    const matches = [...text.matchAll(regex)]
    let result = ''
    let cursor = 0
    for (const match of matches) {
      result += text.slice(cursor, match.index) + (await replacer(match))
      cursor = match.index! + match[0].length
    }
    return result + text.slice(cursor)
  }
  const css = async (text: string, source: string, depth = 0): Promise<string> => {
    if (depth > 8) throw new Error('Stylesheet imports are cyclic or too deep')
    let expanded = await replaceAsync(
      text,
      /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?\s*;/giu,
      async (match) => {
        const file = assetPath(match[1]!, source)
        return css((await read(file)).toString('utf8'), file, depth + 1)
      }
    )
    if (/@import\s/iu.test(expanded))
      throw new Error('Unsupported stylesheet import; inline it before exporting')
    expanded = await replaceAsync(
      expanded,
      /url\(\s*["']?([^"')]+)["']?\s*\)/giu,
      async (match) => {
        const reference = match[1]!.trim()
        if (/^(?:data:|#)/iu.test(reference)) return match[0]
        const file = assetPath(reference, source)
        const data = await read(file)
        return `url("data:${mimeTypeForPath(file).split(';')[0]};base64,${data.toString('base64')}")`
      }
    )
    return expanded
  }
  const attribute = (tag: string, name: string): string | null => {
    const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'iu'))
    return match?.[1] ?? null
  }
  const inline = async (entry: string): Promise<string> => {
    const source = join(root, entry)
    let html = (await read(source)).toString('utf8')
    if (/data-cio-canvas\b/iu.test(html))
      throw new Error('A Screen Canvas needs ZIP export to preserve its framed screens')
    html = await replaceAsync(html, /<link\b[^>]*>/giu, async ([tag]) => {
      if (attribute(tag, 'rel')?.toLowerCase() !== 'stylesheet') return tag
      const reference = attribute(tag, 'href')
      if (!reference) return tag
      const file = assetPath(reference, source)
      const text =
        reference === '/__cio/canvas.css'
          ? screenCanvasRuntimeStyle()
          : await css((await read(file)).toString('utf8'), file)
      const media = attribute(tag, 'media')
      return `<style>${(media ? `@media ${media}{${text}}` : text).replace(/<\/style/giu, '<\\/style')}</style>`
    })
    html = await replaceAsync(html, /<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, async ([tag]) => {
      const reference = attribute(tag.split('>')[0]!, 'src')
      if (!reference) return tag
      if (attribute(tag, 'type') === 'module')
        throw new Error('Module scripts require ZIP export to preserve their imports')
      let script =
        reference === '/__cio/canvas.js'
          ? screenCanvasRuntimeScript()
          : reference === '/__cio/tweaks.js'
            ? designTweaksRuntimeScript()
            : (await read(assetPath(reference, source))).toString('utf8')
      if (/\bdefer\b/iu.test(tag.split('>')[0]!)) {
        script = `document.addEventListener('DOMContentLoaded',function(){${script}\n},{once:true});`
      }
      return `<script>${script.replace(/<\/script/giu, '<\\/script')}</script>`
    })
    html = await replaceAsync(
      html,
      /<style\b[^>]*>([\s\S]*?)<\/style\s*>/giu,
      async (match) => `<style>${await css(match[1]!, source)}</style>`
    )
    html = await replaceAsync(
      html,
      /<(?:img|source|video|audio|input)\b[^>]*>/giu,
      async ([tag]) => {
        if (/\bsrcset\s*=/iu.test(tag))
          throw new Error('Responsive srcset assets require ZIP export')
        let updated = tag
        for (const name of ['src', 'poster']) {
          const reference = attribute(tag, name)
          if (!reference || /^(?:data:|#)/iu.test(reference)) continue
          const file = assetPath(reference, source)
          const data = await read(file)
          updated = updated.replace(
            reference,
            `data:${mimeTypeForPath(file).split(';')[0]};base64,${data.toString('base64')}`
          )
        }
        return updated
      }
    )
    html = await replaceAsync(html, /\bstyle\s*=\s*(["'])(.*?)\1/giu, async (match) => {
      const value = await css(match[2]!, source)
      return `style=${match[1]}${value.replaceAll(match[1]!, match[1] === '"' ? '&quot;' : '&#39;')}${match[1]}`
    })
    if (/<iframe\b/iu.test(html))
      throw new Error('Frames require ZIP export to preserve their pages')
    return html
  }
  await mkdir(request.output, { recursive: true })
  const files: string[] = []
  const archive = new JSZip()
  if (request.format === 'zip') {
    const walk = async (folder: string): Promise<void> => {
      for (const item of await readdir(folder, { withFileTypes: true })) {
        if (item.name.startsWith('.') || item.name === 'node_modules' || item.name === 'exports')
          continue
        const path = join(folder, item.name)
        if (item.isDirectory()) await walk(path)
        else if (item.isFile()) {
          const name = relative(root, path).replaceAll('\\', '/')
          if (
            request.entries.length === 1 &&
            !isScreenCanvasEntry(request.entries[0]!) &&
            /\.html$/iu.test(name) &&
            name !== request.entries[0]
          )
            continue
          archive.file(name, await read(path))
        }
      }
    }
    await walk(root)
    archive.file('__cio/canvas.js', screenCanvasRuntimeScript())
    archive.file('__cio/canvas.css', screenCanvasRuntimeStyle())
    archive.file('__cio/tweaks.js', designTweaksRuntimeScript())
  } else {
    for (const entry of request.entries) {
      const source = (await read(join(root, entry))).toString('utf8')
      const contents =
        request.format === 'html'
          ? await inline(entry)
          : source
              .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, '')
              .replace(
                /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/giu,
                (_, level: string, text: string) => `\n${'#'.repeat(Number(level))} ${text}\n`
              )
              .replace(/<\/(?:p|div|section|li)>/giu, '\n\n')
              .replace(/<[^>]+>/gu, '')
              .replace(/\n{3,}/gu, '\n\n')
              .trim()
      const outputName = request.format === 'html' ? entry : entry.replace(/\.html$/iu, '.md')
      if (request.entries.length === 1) {
        await mkdir(dirname(join(request.output, outputName)), { recursive: true })
        await writeFile(join(request.output, outputName), contents)
        files.push(outputName)
      } else archive.file(outputName, contents)
      parentPort?.postMessage({ type: 'progress', detail: `Exported ${entry}` })
    }
  }
  if (request.format === 'zip' || request.entries.length > 1) {
    const name = `design-${request.format}.zip`
    const compressed = await archive.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 3 }
    })
    await writeFile(join(request.output, name), compressed)
    files.push(name)
  }
  return files
}
if (parentPort) {
  void exportDesignFiles(workerData as ExportWorkerRequest)
    .then((files) => parentPort!.postMessage({ type: 'result', files }))
    .catch((error: unknown) =>
      parentPort!.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    )
}
