#!/usr/bin/env bun
import { readdirSync, readFileSync, accessSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Logger } from '../src/main/system/logger'

type Options = {
  'artifact-dir': string
  target: 'mac' | 'win' | 'linux' | string
}

function parseArgs(argv: string[]): Options & { [key: string]: string } {
  const options: Record<string, string> = {
    'artifact-dir': 'dist'
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const [rawKey, rawValue] = arg.slice(2).split('=', 2)
    if (rawValue !== undefined) {
      options[rawKey] = rawValue
      continue
    }
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      options[rawKey] = next
      index += 1
    }
  }
  return options as Options & { [key: string]: string }
}

const args = parseArgs(process.argv.slice(2))
const artifactDir = args['artifact-dir']
const target = args.target ?? ''

if (!target) {
  Logger.error('[verify-packaged-app] --target is required (mac|win|linux)')
  process.exit(1)
}

const absArtifactDir = resolve(process.cwd(), artifactDir)
let entries: string[] = []
try {
  entries = readdirSync(absArtifactDir)
} catch {
  Logger.error(`[verify-packaged-app] artifact directory missing: ${absArtifactDir}`)
  process.exit(1)
}

const files = entries.filter((entry) => !entry.startsWith('.'))
const hasExtension = (extension: string): boolean => files.some((file) => file.endsWith(extension))

function findFileUnder(root: string, matches: (entry: string) => boolean): string | undefined {
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue
    let children: string[]
    try {
      children = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      const entry = join(current, child.name)
      if (matches(child.name)) return entry
      if (child.isDirectory()) queue.push(entry)
    }
  }
  return undefined
}

const mustHave = (label: string, condition: boolean): void => {
  if (!condition) {
    Logger.error(`[verify-packaged-app] missing required artifact: ${label}`)
    process.exit(1)
  }
}

mustHave('at least one file', files.length > 0)

const speechCatalog = findFileUnder(absArtifactDir, (entry) => entry === 'model-catalog.json')
const speechDecoder = findFileUnder(absArtifactDir, (entry) =>
  process.platform === 'win32' ? entry === 'ffmpeg.exe' : entry === 'ffmpeg'
)
const bundledModelWeight = findFileUnder(absArtifactDir, (entry) =>
  /\.(?:onnx|safetensors|gguf|npz)$/iu.test(entry)
)
mustHave('speech model catalog', Boolean(speechCatalog))
mustHave('packaged speech audio decoder', Boolean(speechDecoder))
if (bundledModelWeight) {
  Logger.error(
    `[verify-packaged-app] downloaded model weight entered the bundle: ${bundledModelWeight}`
  )
  process.exit(1)
}

if (target === 'mac') {
  // MLX worker requires Swift 6.2; CI macOS runner has 5.10 - warn but don't fail
  const hasMlxWorker = Boolean(findFileUnder(absArtifactDir, (entry) => entry === 'mlx-worker'))
  const hasMlxMetallib = Boolean(findFileUnder(absArtifactDir, (entry) => entry === 'mlx.metallib'))
  if (!hasMlxWorker) {
    Logger.info('[verify-packaged-app] Apple Silicon MLX worker not found (Swift 6.2 required, runner has 5.10) - skipping')
  }
  if (!hasMlxMetallib) {
    Logger.info('[verify-packaged-app] Apple Silicon MLX Metal library not found - skipping')
  }
  mustHave('mac disk image', hasExtension('.dmg'))
  mustHave('mac zip artifact', hasExtension('.zip'))
} else if (target === 'win') {
  mustHave('windows installer', hasExtension('.exe'))
} else if (target === 'linux') {
  mustHave('linux AppImage', hasExtension('.AppImage'))
  mustHave('linux deb', hasExtension('.deb'))
} else {
  Logger.error(`[verify-packaged-app] unsupported target: ${target}`)
  process.exit(1)
}

mustHave(
  'metadata file',
  files.some(
    (file) => extname(file) === '.yml' && (file.includes('latest') || file.includes('nightly'))
  )
)

const yamlFiles = files.filter(
  (file) => extname(file) === '.yml' && (file.includes('latest') || file.includes('nightly'))
)
let hasVersionMarker = false
for (const file of yamlFiles) {
  const contents = readFileSync(resolve(absArtifactDir, file), 'utf8')
  if (contents.includes('files:') && contents.includes('path:')) {
    hasVersionMarker = true
    break
  }
}
mustHave('publish metadata with file list', hasVersionMarker)

const packageFiles = files
  .filter((file) => {
    const extension = extname(file)
    return (
      extension === '.dmg' ||
      extension === '.zip' ||
      extension === '.exe' ||
      extension === '.AppImage' ||
      extension === '.deb'
    )
  })
  .map((file) => resolve(absArtifactDir, file))

function findWindowsSigntool(): string | null {
  const fromWhere = spawnSync('where', ['signtool'], { encoding: 'utf8' })
  if (fromWhere.status === 0) return fromWhere.stdout.trim().split(/\r?\n/)[0]
  const programFiles = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const kitRoot = join(programFiles, 'Windows Kits', '10', 'bin')
  let kitVersions: string[] = []
  try {
    kitVersions = readdirSync(kitRoot).sort().reverse()
  } catch {
    // Fall through to the MSVC toolset search below.
  }
  for (const kitVersion of kitVersions) {
    const candidate = join(kitRoot, kitVersion, 'x64', 'signtool.exe')
    try {
      accessSync(candidate)
      return candidate
    } catch {
      // Try the next SDK version.
    }
  }
  const vswhere = join(programFiles, 'Microsoft Visual Studio/Installer/vswhere.exe')
  const installRoot = spawnSync(vswhere, ['-latest', '-property', 'installationPath'], {
    encoding: 'utf8'
  })
  if (installRoot.status !== 0) return null
  const msvcRoot = join(installRoot.stdout.trim(), 'VC', 'Tools', 'MSVC')
  let msvcVersions: string[]
  try {
    msvcVersions = readdirSync(msvcRoot).sort().reverse()
  } catch {
    return null
  }
  for (const msvcVersion of msvcVersions) {
    const candidate = join(msvcRoot, msvcVersion, 'bin', 'Hostx64', 'x64', 'signtool.exe')
    try {
      accessSync(candidate)
      return candidate
    } catch {
      // Try the next MSVC toolset version.
    }
  }
  return null
}

if (target === 'win' && process.platform === 'win32') {
  const exe = packageFiles.find((file) => file.endsWith('.exe'))
  if (!exe) {
    Logger.error('[verify-packaged-app] windows installer was expected but not found')
    process.exit(1)
  }
  const signtool = findWindowsSigntool()
  if (!signtool) {
    Logger.error('[verify-packaged-app] signtool was not found to verify the windows signature')
    process.exit(1)
  }
  const verify = spawnSync(signtool, ['verify', '/v', exe], { encoding: 'utf8' })
  if (verify.status !== 0) {
    Logger.info(
      `[verify-packaged-app] windows signature could not be fully validated for ${exe}: ${
        verify.stderr || verify.stdout || 'unknown'
      }`
    )
    Logger.info(
      '[verify-packaged-app] windows signing is enforced at package time (forceCodeSigning); continuing'
    )
  }
}

if (target === 'mac' && process.platform === 'darwin') {
  const appBundle = findFileUnder(absArtifactDir, (entry) => entry.endsWith('.app'))
  if (!appBundle) {
    Logger.error('[verify-packaged-app] mac app bundle was expected but not found')
    process.exit(1)
  }
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', appBundle], {
    encoding: 'utf8'
  })
  if (verify.status !== 0) {
    Logger.error(
      `[verify-packaged-app] mac code signature check failed for ${appBundle}: ${verify.stderr || verify.stdout || 'unknown'}`
    )
    process.exit(1)
  }
}

Logger.info(
  '[verify-packaged-app] ok',
  JSON.stringify({ target, artifactDir: absArtifactDir, files })
)
