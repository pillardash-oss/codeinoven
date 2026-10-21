/**
 * Prints what this machine's Visual Studio installations actually contain, and
 * which one node-gyp would pick. Run it on Windows when a native rebuild fails
 * with MSB8020 or a toolset mismatch:
 *
 *   bun scripts/inspect-msvc.ts
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Logger } from '../src/main/system/logger'

interface Installation {
  installationPath: string
  installationVersion: string
  packages: string[]
}

const require = createRequire(import.meta.url)

function vswherePath(): string {
  const programFiles = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  return join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
}

function packageIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      ids.push(entry)
    } else if (typeof entry === 'object' && entry !== null && 'id' in entry) {
      const { id } = entry
      if (typeof id === 'string') ids.push(id)
    }
  }
  return ids
}

function installations(): Installation[] {
  const vswhere = vswherePath()
  if (!existsSync(vswhere)) {
    Logger.info('vswhere not found at', vswhere)
    return []
  }
  const result = spawnSync(
    vswhere,
    ['-products', '*', '-prerelease', '-include', 'packages', '-format', 'json', '-utf8'],
    { encoding: 'utf8', windowsHide: true }
  )
  if (result.status !== 0) {
    Logger.info('vswhere failed:', result.stderr.replace(/\s+/g, ' ').slice(0, 300))
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const found: Installation[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record.installationPath !== 'string') continue
    if (typeof record.installationVersion !== 'string') continue
    found.push({
      installationPath: record.installationPath,
      installationVersion: record.installationVersion,
      packages: packageIds(record.packages)
    })
  }
  return found
}

function describeToolsets(installationPath: string): string[] {
  const lines: string[] = []
  const msvcRoot = join(installationPath, 'VC', 'Tools', 'MSVC')
  if (existsSync(msvcRoot)) {
    for (const toolset of readdirSync(msvcRoot)) {
      const binRoot = join(msvcRoot, toolset, 'bin')
      if (!existsSync(binRoot)) {
        lines.push(`    ${toolset}: no bin directory`)
        continue
      }
      const compilers = readdirSync(binRoot)
        .filter((host) => host.startsWith('Host'))
        .map((host) =>
          ['arm64', 'x64', 'x86']
            .filter((target) => existsSync(join(binRoot, host, target, 'cl.exe')))
            .map((target) => `${host}/${target}`)
            .join(',')
        )
        .filter((entry) => entry.length > 0)
      lines.push(`    ${toolset}: ${compilers.length > 0 ? compilers.join(' | ') : 'no cl.exe'}`)
    }
  } else {
    lines.push('    no VC/Tools/MSVC directory')
  }
  const defaults = join(
    installationPath,
    'VC',
    'Auxiliary',
    'Build',
    'Microsoft.VCToolsVersion.default.txt'
  )
  if (existsSync(defaults)) {
    lines.push(`    default toolset: ${readFileSync(defaults, 'utf8').trim()}`)
  } else {
    lines.push('    no Microsoft.VCToolsVersion.default.txt')
  }
  return lines
}

async function describeSelection(): Promise<string> {
  try {
    const finderPath = require.resolve('node-gyp/lib/find-visualstudio')
    const finder = require(finderPath) as {
      findVisualStudio: (semver: { major: number }, requested?: string) => Promise<unknown>
    }
    const found = await finder.findVisualStudio({
      major: Number(process.versions.node.split('.')[0])
    })
    return typeof found === 'object' && found !== null ? JSON.stringify(found) : String(found)
  } catch (error) {
    return `node-gyp detection failed: ${String(error)}`
  }
}

Logger.info(`platform=${process.platform} arch=${process.arch} node=${process.versions.node}`)
Logger.info(`GYP_MSVS_VERSION=${process.env.GYP_MSVS_VERSION ?? '(unset)'}`)
Logger.info(`npm_config_msvs_version=${process.env.npm_config_msvs_version ?? '(unset)'}`)
Logger.info(`VCINSTALLDIR=${process.env.VCINSTALLDIR ?? '(unset)'}`)

for (const installation of installations()) {
  Logger.info('')
  Logger.info(`${installation.installationPath} (${installation.installationVersion})`)
  const interesting = installation.packages.filter(
    (id) =>
      id.includes('VC.Tools') ||
      id.includes('VC.MSBuild') ||
      id.includes('Windows10SDK') ||
      id.includes('Windows11SDK') ||
      id.includes('Windows81SDK')
  )
  Logger.info(
    `  packages: ${interesting.length > 0 ? interesting.join(', ') : '(none of VC.Tools/MSBuild/SDK)'}`
  )
  for (const line of describeToolsets(installation.installationPath)) Logger.info(line)
}

Logger.info('')
const selection = await describeSelection()
Logger.info(`node-gyp would use: ${selection}`)
