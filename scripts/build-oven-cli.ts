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
  const app = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
    version: string
  }
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

  const manifestFile = join(packageRoot, 'package.json')
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>
  manifest['version'] = app.version
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)

  process.stdout.write(`cio-oven ${app.version}: service bundle and CLI built in ${dist}\n`)
}

await build()
