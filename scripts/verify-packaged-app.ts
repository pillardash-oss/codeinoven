#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs'
import { resolve, extname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Logger } from '../src/main/logger'

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

const mustHave = (label: string, condition: boolean): void => {
  if (!condition) {
    Logger.error(`[verify-packaged-app] missing required artifact: ${label}`)
    process.exit(1)
  }
}

mustHave('at least one file', files.length > 0)

if (target === 'mac') {
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
  files.some((file) => extname(file) === '.yml' && file.includes('latest'))
)

const yamlFiles = files.filter((file) => extname(file) === '.yml' && file.includes('latest'))
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

if (target === 'win' && process.platform === 'win32') {
  const exe = packageFiles.find((file) => file.endsWith('.exe'))
  if (!exe) {
    Logger.error('[verify-packaged-app] windows installer was expected but not found')
    process.exit(1)
  }
  const escapedPath = exe.replace(/'/g, "''")
  const verify = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$sig = Get-AuthenticodeSignature -FilePath '${escapedPath}'; if ($sig.Status -ne 'Valid') { throw ("Authenticode signature status: $($sig.Status)") } if (-not $sig.SignerCertificate) { throw 'Missing signer certificate' }`
    ],
    { encoding: 'utf8' }
  )
  if (verify.status !== 0) {
    Logger.error(
      `[verify-packaged-app] windows signature check failed for ${exe}: ${verify.stderr || verify.stdout || 'unknown'}`
    )
    process.exit(1)
  }
}

if (target === 'mac' && process.platform === 'darwin') {
  const dmg = packageFiles.find((file) => file.endsWith('.dmg'))
  if (!dmg) {
    Logger.error('[verify-packaged-app] mac dmg artifact was expected but not found')
    process.exit(1)
  }
  const verify = spawnSync('codesign', ['-dv', dmg], { encoding: 'utf8' })
  if (verify.status !== 0) {
    Logger.error('[verify-packaged-app] mac code signature check failed for', dmg)
    process.exit(1)
  }
}

Logger.info(
  '[verify-packaged-app] ok',
  JSON.stringify({ target, artifactDir: absArtifactDir, files })
)
