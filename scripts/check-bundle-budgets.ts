/**
 * Bundle-budget check for the production renderer build.
 *
 * Reads the built renderer output (default `out/renderer`) and enforces the
 * audit's desktop and remote budgets over each **eagerly-loaded initial JS
 * closure** — the entry plus the chunks Vite emits as modulepreloads:
 *
 * - initial desktop JavaScript raw ≤ 4.5 MiB and gzip ≤ 1 MiB
 * - initial remote JavaScript (gzip) ≤ 500 KB
 * - no single initial JS chunk (gzip) > 350 KB
 *
 * Truly lazy dynamic imports and their modulepreload dep arrays are excluded
 * from the measurement. The closure is derived from the same production asset
 * graph the LAN gateway uses, so the check measures exactly what a phone loads
 * to show the first screen. Exits non-zero (deterministically) when a budget
 * is exceeded.
 *
 * Usage: `bun run check:bundle [path/to/renderer-out]`
 */
/// <reference types="node" />

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  computePwaAssetGraph,
  INITIAL_JS_GZIP_BUDGET_BYTES,
  MAX_CHUNK_GZIP_BUDGET_BYTES
} from '../src/main/remote/pwa-asset-graph'

const staticRoot = resolve(process.cwd(), process.argv[2] ?? 'out/renderer')
// The post-split baseline is ~4.30 MB raw / ~0.92 MB gzip. These thresholds
// leave modest build-hash/minifier variance while still rejecting the former
// 7.95 MB raw / 1.99 MB gzip eager closure.
const DESKTOP_INITIAL_JS_RAW_BUDGET_BYTES = 4.5 * 1024 * 1024
const DESKTOP_INITIAL_JS_GZIP_BUDGET_BYTES = 1100 * 1024

interface DesktopChunkBudget {
  url: string
  rawBytes: number
  gzipBytes: number
}

interface DesktopBudget {
  chunks: DesktopChunkBudget[]
  initialJsRawBytes: number
  initialJsGzipBytes: number
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}=["']([^"']+)["']`, 'iu').exec(tag)
  return match?.[1] ?? null
}

/** Measure exactly what Chromium receives eagerly from the desktop HTML: the
 * module entry and every JavaScript `modulepreload`. Interaction-only dynamic
 * imports are intentionally absent until the user opens that feature. */
async function computeDesktopBudget(): Promise<DesktopBudget> {
  const html = await readFile(resolve(staticRoot, 'index.html'), 'utf8')
  const urls = new Set<string>()
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*>/giu)) {
    const tag = match[0]
    if (tag.startsWith('<link')) {
      const rel = attribute(tag, 'rel')
      if (rel !== 'modulepreload') continue
    }
    const url = attribute(tag, tag.startsWith('<script') ? 'src' : 'href')
    if (url && /\.m?js(?:\?.*)?$/iu.test(url)) urls.add(url)
  }

  const chunks: DesktopChunkBudget[] = []
  for (const url of [...urls].sort()) {
    const path = resolve(staticRoot, url.replace(/^\.\//u, '').split('?')[0])
    const raw = await readFile(path)
    chunks.push({ url, rawBytes: raw.byteLength, gzipBytes: gzipSync(raw).byteLength })
  }
  return {
    chunks,
    initialJsRawBytes: chunks.reduce((total, chunk) => total + chunk.rawBytes, 0),
    initialJsGzipBytes: chunks.reduce((total, chunk) => total + chunk.gzipBytes, 0)
  }
}

async function main(): Promise<void> {
  if (!existsSync(resolve(staticRoot, 'remote.html'))) {
    fail(
      `No PWA build found at ${staticRoot} (remote.html missing). ` +
        'Run `bun run build:production` before checking bundle budgets.'
    )
  }
  if (!existsSync(resolve(staticRoot, 'index.html'))) {
    fail(
      `No desktop build found at ${staticRoot} (index.html missing). ` +
        'Run `bun run build:production` before checking bundle budgets.'
    )
  }

  const desktop = await computeDesktopBudget()
  const desktopChunkRows = desktop.chunks
    .map((chunk) => `${chunk.url}\n    raw ${chunk.rawBytes} B  gzip ${chunk.gzipBytes} B`)
    .join('\n')
  const desktopRawExceeded = desktop.initialJsRawBytes > DESKTOP_INITIAL_JS_RAW_BUDGET_BYTES
  const desktopGzipExceeded = desktop.initialJsGzipBytes > DESKTOP_INITIAL_JS_GZIP_BUDGET_BYTES

  process.stdout.write(
    `Initial desktop JS budget check (${staticRoot})\n` +
      `  initial JS raw total: ${desktop.initialJsRawBytes} B` +
      ` (budget ${DESKTOP_INITIAL_JS_RAW_BUDGET_BYTES} B)` +
      `${desktopRawExceeded ? '  ← OVER BUDGET' : ''}\n` +
      `  initial JS gzip total: ${desktop.initialJsGzipBytes} B` +
      ` (budget ${DESKTOP_INITIAL_JS_GZIP_BUDGET_BYTES} B)` +
      `${desktopGzipExceeded ? '  ← OVER BUDGET' : ''}\n`
  )
  if (desktopChunkRows) process.stdout.write(`  chunks:\n  ${desktopChunkRows}\n`)

  if (desktopRawExceeded || desktopGzipExceeded) {
    fail(
      'Desktop bundle budget exceeded:\n' +
        `  initial JS raw ${desktop.initialJsRawBytes} B > ` +
        `${DESKTOP_INITIAL_JS_RAW_BUDGET_BYTES} B: ${desktopRawExceeded}\n` +
        `  initial JS gzip ${desktop.initialJsGzipBytes} B > ` +
        `${DESKTOP_INITIAL_JS_GZIP_BUDGET_BYTES} B: ${desktopGzipExceeded}`
    )
  }

  process.stdout.write('PASS: desktop initial JS closure within budget.\n')

  const graph = await computePwaAssetGraph(staticRoot)
  const { budget } = graph
  const chunkRows = budget.chunks
    .map(
      (chunk) =>
        `${chunk.url}\n    raw ${chunk.rawBytes} B  gzip ${chunk.gzipBytes} B` +
        `${chunk.gzipBytes > MAX_CHUNK_GZIP_BUDGET_BYTES ? '  ← OVER MAX CHUNK BUDGET' : ''}`
    )
    .join('\n')

  process.stdout.write(
    `Initial remote JS budget check (${staticRoot})\n` +
      `  initial JS gzip total: ${budget.initialJsGzipBytes} B` +
      ` (budget ${INITIAL_JS_GZIP_BUDGET_BYTES} B)` +
      `${budget.initialJsGzipBytes > INITIAL_JS_GZIP_BUDGET_BYTES ? '  ← OVER BUDGET' : ''}\n` +
      `  max initial chunk gzip: ${budget.maxInitialChunkGzipBytes} B` +
      ` (budget ${MAX_CHUNK_GZIP_BUDGET_BYTES} B)` +
      `${budget.maxInitialChunkGzipBytes > MAX_CHUNK_GZIP_BUDGET_BYTES ? '  ← OVER BUDGET' : ''}\n`
  )
  if (chunkRows) process.stdout.write(`  chunks:\n  ${chunkRows}\n`)

  const exceeded = budget.chunks.some((chunk) => chunk.gzipBytes > MAX_CHUNK_GZIP_BUDGET_BYTES)
  const overTotal = budget.initialJsGzipBytes > INITIAL_JS_GZIP_BUDGET_BYTES

  if (overTotal || exceeded) {
    fail(
      'Bundle budget exceeded:\n' +
        `  initial JS gzip ${budget.initialJsGzipBytes} B > ` +
        `${INITIAL_JS_GZIP_BUDGET_BYTES} B: ${overTotal}\n` +
        `  single chunk gzip > ${MAX_CHUNK_GZIP_BUDGET_BYTES} B: ${exceeded}`
    )
  }

  process.stdout.write('PASS: remote PWA initial JS closure within budget.\n')
}

void main()
