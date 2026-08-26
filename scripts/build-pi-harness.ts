import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Copies the pinned pi CLI's compiled bundle into `resources/harnesses/pi`
 * for electron-builder to ship as extraResources. Only `dist/` (the
 * self-contained esbuild output — provider SDKs are already inlined) and
 * `jiti` (the one real runtime dependency, used to load `.ts` extensions)
 * are needed; the rest of pi's `node_modules` tree is build-time-only.
 */

const projectRoot = join(fileURLToPath(new URL('..', import.meta.url)))
const outputDirectory = join(projectRoot, 'resources/harnesses/pi')
const require = createRequire(import.meta.url)

const piPackageJsonPath = require.resolve('@earendil-works/pi-coding-agent/package.json')
const piPackageDirectory = dirname(piPackageJsonPath)
const jitiPackageJsonPath = require.resolve('jiti/package.json', { paths: [piPackageDirectory] })
const jitiPackageDirectory = dirname(jitiPackageJsonPath)

const piPackageJson = await import(piPackageJsonPath, { with: { type: 'json' } })
const version: string = piPackageJson.default.version

await rm(outputDirectory, { recursive: true, force: true })
await mkdir(outputDirectory, { recursive: true })

await cp(join(piPackageDirectory, 'dist'), join(outputDirectory, 'dist'), { recursive: true })
await cp(piPackageJsonPath, join(outputDirectory, 'package.json'))
// Named "vendor", not "node_modules" — electron-builder's extraResources copy
// silently drops nested `node_modules` directories, so the runtime resolves
// this one via NODE_PATH instead of Node's standard node_modules walk.
await cp(jitiPackageDirectory, join(outputDirectory, 'vendor/jiti'), { recursive: true })
await writeFile(join(outputDirectory, '.version'), `${version}\n`)

// eslint-disable-next-line no-console
console.log(`bundled pi ${version} -> resources/harnesses/pi`)
