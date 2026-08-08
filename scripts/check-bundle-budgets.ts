/**
 * Bundle-budget check for the production renderer build.
 *
 * Reads the built renderer output (default `out/renderer`) and enforces the
 * audit's remote PWA budgets:
 *
 * - initial remote JavaScript (the disconnected shell's directly-referenced
 *   JS, measured gzip) ≤ 500 KB
 * - no single initial JS chunk (gzip) > 350 KB
 *
 * The initial closure is derived from the same production asset graph the LAN
 * gateway uses, so the check measures exactly what a phone loads on first
 * paint. Exits non-zero (deterministically) when a budget is exceeded.
 *
 * Usage: `bun run check:bundle [path/to/renderer-out]`
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { computePwaAssetGraph } from '../src/main/remote/pwa-asset-graph'

/** gzip bytes budget for the whole initial remote JS closure. */
const INITIAL_JS_GZIP_BUDGET_BYTES = 500 * 1024
/** gzip bytes budget for any single initial JS chunk. */
const MAX_CHUNK_GZIP_BUDGET_BYTES = 350 * 1024

const staticRoot = resolve(process.cwd(), process.argv[2] ?? 'out/renderer')

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

async function main(): Promise<void> {
  if (!existsSync(resolve(staticRoot, 'remote.html'))) {
    fail(
      `No PWA build found at ${staticRoot} (remote.html missing). ` +
        'Run `bun run build:production` before checking bundle budgets.'
    )
  }

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
