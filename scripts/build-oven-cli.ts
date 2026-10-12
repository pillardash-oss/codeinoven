import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeServiceBundle } from '../src/main/ovens/oven-service-bundle'

/**
 * Build the publishable `cio-oven` package.
 *
 * Three things have to agree or the CLI is useless: the bundle it installs, the
 * revision it reports to the app, and the version it publishes under. This script
 * derives all three from one app build, so `npx cio-oven` can never hand an Oven
 * a service the app considers stale.
 */
const repoRoot = join(import.meta.dirname, '..')
const packageRoot = join(repoRoot, 'packages', 'cio-oven')
const bundleFile = join(repoRoot, 'out', 'main', 'oven-service.mjs')
const dist = join(packageRoot, 'dist')

async function build(): Promise<void> {
  let bundle: string
  try {
    bundle = await readFile(bundleFile, 'utf8')
  } catch {
    throw new Error(
      `The Oven service bundle is missing at ${bundleFile}. Run \`bun run build\` first.`
    )
  }

  await rm(dist, { recursive: true, force: true })
  await mkdir(dist, { recursive: true })
  await writeFile(join(dist, 'service.mjs'), normalizeServiceBundle(bundle), { mode: 0o644 })
  await copyFile(join(repoRoot, 'LICENSE'), join(packageRoot, 'LICENSE'))

  const result = await Bun.build({
    entrypoints: [join(packageRoot, 'src', 'cli.ts')],
    outdir: dist,
    target: 'node',
    format: 'esm',
    naming: 'cli.mjs'
  })
  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${log.message}\n`)
    throw new Error('The cio-oven CLI failed to build.')
  }

  // The CLI is released on its own cadence, so its version lives in its own
  // manifest and never moves with the desktop app's. Bump it alone with
  // `bun run oven:version:bump` before publishing; the app version is managed by
  // the release pipeline and must not be touched here.
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    version: string
  }

  process.stdout.write(`cio-oven ${manifest.version}: service bundle and CLI built in ${dist}\n`)
}

await build()
