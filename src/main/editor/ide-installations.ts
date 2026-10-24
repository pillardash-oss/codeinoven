import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { IDE_SERVER_PACKAGES, type IdeLanguageServer } from '../../lib/ide-language-servers'
import type { IdeInstallation } from '../../lib/editor-ide'

interface UpdateRecord {
  latestVersion: string
  checkedAt: number
}
const checks = new Map<string, Promise<UpdateRecord>>()
const lanes: Promise<void>[] = [Promise.resolve(), Promise.resolve()]
let nextLane = 0
let persistence: Promise<void> = Promise.resolve()

async function readUpdates(file: string): Promise<Record<string, UpdateRecord>> {
  try {
    if ((await stat(file)).size > 65536) return {}
    const value: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value)
        .filter((entry): entry is [string, UpdateRecord] => {
          const item: unknown = entry[1]
          return Boolean(
            item &&
            typeof item === 'object' &&
            'latestVersion' in item &&
            typeof item.latestVersion === 'string' &&
            item.latestVersion.length < 100 &&
            'checkedAt' in item &&
            typeof item.checkedAt === 'number'
          )
        })
        .slice(-128)
    )
  } catch {
    return {}
  }
}

async function latest(packageName: string): Promise<UpdateRecord> {
  let pending = checks.get(packageName)
  if (!pending) {
    if (checks.size >= 32) throw new Error('Update checks are busy')
    const lane = nextLane++ % lanes.length
    pending = lanes[lane]
      .catch(() => undefined)
      .then(async () => {
        const response = await fetch(
          `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
          { signal: AbortSignal.timeout(8000) }
        )
        if (!response.ok) throw new Error('Update check unavailable')
        const data: unknown = await response.json()
        if (
          !data ||
          typeof data !== 'object' ||
          !('version' in data) ||
          typeof data.version !== 'string' ||
          data.version.length > 100
        )
          throw new Error('Invalid update response')
        return { latestVersion: data.version, checkedAt: Date.now() }
      })
    lanes[lane] = pending.then(
      () => undefined,
      () => undefined
    )
    checks.set(packageName, pending)
    void pending.finally(() => checks.delete(packageName)).catch(() => undefined)
  }
  return pending
}

/** Called only by the IDE worker. No timers or polling; checks follow user activity. */
export async function ideInstallations(
  env: NodeJS.ProcessEnv,
  servers: IdeLanguageServer[],
  updates: boolean
): Promise<IdeInstallation[]> {
  const bin = env.CODEINOVEN_IDE_BIN
  if (!bin) return []
  const root = dirname(dirname(bin))
  const file = join(root, 'ide-update-cache.json')
  const cached = await readUpdates(file)
  const installations: IdeInstallation[] = []
  for (const server of servers) {
    const packageName = IDE_SERVER_PACKAGES[server.command]?.[0].split('@')[0]
    const managed = join(bin, server.command)
    const candidates = packageName ? [managed] : []
    if (server.command.includes('/') || server.command.includes('\\'))
      candidates.push(server.command)
    else
      for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean))
        candidates.push(join(directory, server.command))
    let executable: string | undefined
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK)
        if ((await stat(candidate)).isFile()) {
          executable = candidate
          break
        }
      } catch {
        /* Try next candidate. */
      }
    }
    let version: string | undefined
    if (executable === managed && packageName) {
      try {
        const manifest: unknown = JSON.parse(
          await readFile(join(root, 'node_modules', packageName, 'package.json'), 'utf8')
        )
        if (
          manifest &&
          typeof manifest === 'object' &&
          'version' in manifest &&
          typeof manifest.version === 'string'
        )
          version = manifest.version
      } catch {
        /* Partial installations have no known version. */
      }
    }
    installations.push({
      serverId: server.id,
      source: !executable ? 'missing' : executable === managed ? 'managed' : 'external',
      executable,
      packageName,
      version,
      latestVersion: packageName ? cached[packageName]?.latestVersion : undefined
    })
  }
  if (updates) {
    const managed = installations.filter((item) => item.source === 'managed' && item.packageName)
    const changed: Record<string, UpdateRecord> = {}
    const packages = [...new Set(managed.map((item) => item.packageName!))]
    for (let offset = 0; offset < packages.length; offset += 2) {
      await Promise.all(
        packages.slice(offset, offset + 2).map(async (packageName) => {
          const matching = managed.filter((item) => item.packageName === packageName)
          try {
            const result = await latest(packageName)
            changed[packageName] = result
            for (const item of matching) item.latestVersion = result.latestVersion
          } catch {
            for (const item of matching) item.updateError = 'Update check unavailable'
          }
        })
      )
    }
    if (Object.keys(changed).length) {
      const save = persistence
        .catch(() => undefined)
        .then(async () => {
          const merged = { ...(await readUpdates(file)), ...changed }
          const bounded = Object.fromEntries(
            Object.entries(merged)
              .sort((a, b) => a[1].checkedAt - b[1].checkedAt)
              .slice(-128)
          )
          await mkdir(root, { recursive: true })
          await writeFile(`${file}.pending`, JSON.stringify(bounded))
          await rename(`${file}.pending`, file)
        })
      persistence = save
      await save.catch(() => undefined)
    }
  }
  return installations
}
