/******************************************************************************
 *                                                                           *
 *   STOP.  THESE BUDGETS ARE A HARD CEILING, NOT A SUGGESTION.              *
 *                                                                           *
 *   THIS FILE IS UNDER AN EXPLICIT AND STANDING USER FREEZE.                *
 *                                                                           *
 *   YOU, THE AGENT READING THIS, ARE FORBIDDEN FROM RAISING, RELAXING,      *
 *   WIDENING, SPLITTING, ROUNDING UP, OR OTHERWISE WEAKENING ANY BUDGET    *
 *   IN THIS FILE.  NOT BY A BYTE.  NOT "JUST FOR THIS RELEASE".  NOT        *
 *   "TEMPORARILY".  NOT TO GET CI GREEN.  NOT BECAUSE THE CHECK IS         *
 *   INCONVENIENT.  A BUDGET THAT MOVES IS NOT A BUDGET, IT IS A LIE.        *
 *                                                                           *
 *   THESE NUMBERS HAVE ALREADY BEEN RAISED SIX TIMES (SEE BELOW).  THAT     *
 *   HISTORY IS A RECORD OF FAILURE, NOT A PRECEDENT TO CONTINUE.  EACH      *
 *   RAISE SHIPPED A STARTUP REGRESSION STRAIGHT TO THE USER.  THE NEXT      *
 *   RAISE WILL NOT BE TREATED AS A FIX.  IT IS A VIOLATION.                 *
 *                                                                           *
 *   THE ONLY PERMITTED RESPONSE TO "THE BUILD IS OVER BUDGET" IS TO MAKE    *
 *   THE FIRST SCREEN LIGHTER:  MOVE WORK BEHIND A DYNAMIC import(),        *
 *   DELETE DEAD CODE, ELIMINATE EAGER DEPENDENCIES.  NEVER TOUCH THE        *
 *   CEILING.  IF YOU CHANGE A NUMBER HERE TO SILENCE A FAILURE, YOU HAVE    *
 *   SOLVED NOTHING AND YOU HAVE LIED TO THE USER.                          *
 *                                                                           *
 *   RAISING A BUDGET REQUIRES THE USER'S PRIOR, EXPLICIT, FORMAL APPROVAL.  *
 *   NOT AN INFERENCE, NOT A SILENCE, NOT A "THEY PROBABLY WANT IT".         *
 *   AN ACTUAL STATEMENT FROM THE USER SAYING TO RAISE IT.  WITHOUT THAT    *
 *   APPROVAL ON RECORD, ANY CHANGE TO THESE CONSTANTS IS A REGRESSION       *
 *   YOU ARE SHIPPING ON PURPOSE.  DO NOT DO IT.                            *
 *                                                                           *
 ******************************************************************************/
/**
 * Bundle-budget check for the production renderer build.
 *
 * Reads the built renderer output (default `out/renderer`) and enforces the
 * audit's budgets over each **eagerly-loaded initial JS closure** — the entry
 * plus the chunks Vite emits as modulepreloads:
 *
 * - initial JavaScript raw ≤ 3 MiB and gzip ≤ 900 KiB
 *
 * Truly lazy dynamic imports and their modulepreload dep arrays are excluded
 * from the measurement, so the check measures exactly what the app loads to
 * show the first screen. Exits non-zero (deterministically) when a budget is
 * exceeded.
 *
 * Usage: `bun run check:bundle [path/to/renderer-out]`
 */
/// <reference types="node" />

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const staticRoot = resolve(process.cwd(), process.argv[2] ?? 'out/renderer')
// The renderer is minified (`build.minify: 'oxc'` in electron.vite.config.ts), so
// these thresholds measure a minified closure, not a formatted one. The budget
// that preceded this one was 5.75 MiB raw / 1.5 MiB gzip and had been raised six
// times between August and October 2026 - 4.5/1.0, 4.6/1.2, 5.0/1.3, 5.5/1.3,
// 5.5/1.4, 5.75/1.5 - while the closure it was meant to bound grew with every
// feature added to the first screen. Raising the ceiling is how a startup
// regression ships, so the budget now sits just above the measured minified
// closure (~2.48 MiB raw / ~0.74 MiB gzip) and a heavier first screen must be
// paid for by making something lazy instead. See `STARTUP_BUDGET_MS` for the
// runtime half of the same promise.
//
// ============================ DO NOT RAISE ================================
// Raising either constant below is PROHIBITED without the user's explicit,
// prior, formal approval. "The build is over budget" is fixed by making the
// first screen lighter, never by moving the ceiling. A number changed here to
// silence a failing check is a startup regression deliberately shipped to the
// user. Read the freeze notice at the top of this file before you even think
// about editing a value on the next two lines.
// ===========================================================================
const DESKTOP_INITIAL_JS_RAW_BUDGET_BYTES = 3 * 1024 * 1024
// Windows Minifier output runs ~35 KiB heavier gzip than macOS/Linux.
// Do not raise this either. Same freeze, same rule, no exceptions.
const DESKTOP_INITIAL_JS_GZIP_BUDGET_BYTES = 900 * 1024

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
  if (!existsSync(resolve(staticRoot, 'index.html'))) {
    fail(
      `No desktop build found at ${staticRoot} (index.html missing). ` +
        'Run `bun run build:production` before checking bundle budgets.'
    )
  }
  const rendererFiles = await import('node:fs/promises').then(({ readdir }) =>
    readdir(staticRoot, { recursive: true })
  )
  const bundledModel = rendererFiles.find((entry) => /\.(?:onnx|safetensors|gguf)$/iu.test(entry))
  if (bundledModel) fail(`Downloaded speech model entered the renderer bundle: ${bundledModel}`)

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
}

void main()
