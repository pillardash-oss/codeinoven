import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type {
  AgentPluginMarketEntry,
  AgentPluginMarketplace,
  InstalledAgentPlugin,
  McpUtilityConfig,
  UtilityDefinitionInput
} from '../../lib/types'
import type { StorageEngine } from '../storage/storage-engine'
import { UtilityRegistryService } from './utility-registry-service'

const MARKETPLACES_FILE = 'plugins/marketplaces.json'
const INSTALLED_FILE = 'plugins/installed.json'
const BOOKMARKS_FILE = 'plugins/bookmarks.json'
const SEEDED_FILE = 'plugins/default-marketplaces-seeded.json'
const MAX_PLUGIN_FILES = 300
const MAX_PLUGIN_BYTES = 8 * 1024 * 1024
const MAX_PLUGIN_FILE_BYTES = 2 * 1024 * 1024
const MAX_GITHUB_JSON_BYTES = 16 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 20_000
const DEFAULT_MARKETPLACES: Array<{ url: string; platform: Platform }> = [
  { url: 'openai/community-plugins', platform: 'codex' },
  { url: 'anthropics/claude-plugins-official', platform: 'claude' }
]
const defaultBranches = new Map<string, Promise<string>>()

type Platform = 'codex' | 'claude'
interface Source {
  repository: string
  ref: string
  path: string
}
interface PluginCandidate {
  id: string
  name: string
  displayName: string
  description: string
  version: string | null
  publisher: string | null
  iconUrl: string | null
  homepage: string | null
  source: Source
  components: AgentPluginMarketEntry['components']
  unsupportedReason?: string
}
interface GitTreeEntry {
  path: string
  type: string
  size?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRecord<T>(raw: string | null, key: string): T[] {
  if (!raw) return []
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed) || !Array.isArray(parsed[key])) return []
  return parsed[key] as T[]
}

function cleanText(value: unknown, fallback: string, max = 500): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback
}

function githubRepository(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const shorthand = value.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/u)
  if (shorthand) return shorthand[1]!
  try {
    const url = new URL(value.replace(/\.git$/u, ''))
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null
    const segments = url.pathname.split('/').filter(Boolean)
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null
  } catch {
    return null
  }
}

function repoUrl(input: string): { repository: string; ref: string } {
  const text = input.trim()
  const shorthand = text.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:@([A-Za-z0-9._/-]+))?$/u)
  if (shorthand) return { repository: shorthand[1]!, ref: shorthand[2] ?? 'HEAD' }
  const url = new URL(text)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
    throw new TypeError('Plugin marketplaces must be GitHub repositories or HTTPS GitHub URLs')
  }
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length < 2)
    throw new TypeError('Marketplace URL must include an owner and repository')
  return { repository: `${segments[0]}/${segments[1].replace(/\.git$/u, '')}`, ref: 'HEAD' }
}

async function githubJson(path: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CodeInOven/agent-plugins' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`GitHub request failed (${response.status})`)
  const raw = await responseText(response, MAX_GITHUB_JSON_BYTES)
  return JSON.parse(raw) as unknown
}

async function resolvedRef(repository: string, ref: string): Promise<string> {
  if (ref !== 'HEAD') return ref
  const existing = defaultBranches.get(repository)
  if (existing) return existing
  const request = githubJson(`/repos/${repository}`).then((payload) => {
    if (!isRecord(payload) || typeof payload['default_branch'] !== 'string') {
      throw new Error('Could not resolve the GitHub repository default branch')
    }
    return payload['default_branch']
  })
  defaultBranches.set(repository, request)
  try {
    return await request
  } catch (error) {
    defaultBranches.delete(repository)
    throw error
  }
}

async function responseText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error('Plugin response exceeds the download size limit')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new Error('Plugin response exceeds the download size limit')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

async function githubText(
  repository: string,
  ref: string,
  path: string,
  maxBytes = MAX_GITHUB_JSON_BYTES
): Promise<string> {
  const url = `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(ref)}/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
  const response = await fetch(url, {
    headers: { Accept: 'text/plain', 'User-Agent': 'CodeInOven/agent-plugins' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`Plugin file could not be downloaded (${response.status})`)
  return responseText(response, maxBytes)
}

function marketplaceCandidates(
  value: unknown,
  platform: Platform,
  marketplaceId: string,
  repository: string,
  ref: string
): PluginCandidate[] {
  if (!isRecord(value) || !Array.isArray(value['plugins'])) return []
  return value['plugins'].flatMap((entry): PluginCandidate[] => {
    if (!isRecord(entry)) return []
    const name = cleanText(entry['name'], '')
    if (!name) return []
    const sourceValue = entry['source']
    let sourceRepo = repository
    let sourceRef = ref
    let sourcePath = name
    let unsupportedReason: string | undefined
    if (typeof sourceValue === 'string') {
      const match = sourceValue.match(/^github:([^/]+\/[^/]+)(?:\/([^#]+))?(?:#(.+))?$/u)
      if (match) {
        sourceRepo = match[1]!
        sourcePath = match[2] ?? name
        sourceRef = match[3] ?? ref
      } else if (sourceValue.startsWith('./')) {
        sourcePath = sourceValue.slice(2)
      } else if (githubRepository(sourceValue)) {
        sourceRepo = githubRepository(sourceValue) ?? repository
        sourcePath = ''
      } else {
        unsupportedReason = 'This package source is not a GitHub repository.'
      }
    } else if (isRecord(sourceValue)) {
      const kind = sourceValue['source']
      if (kind === 'github' || kind === 'git-subdir' || kind === 'url') {
        const repo = githubRepository(sourceValue['repo'] ?? sourceValue['url'])
        if (repo) sourceRepo = repo
        else return []
        if (typeof sourceValue['ref'] === 'string') sourceRef = sourceValue['ref']
        if (typeof sourceValue['sha'] === 'string') sourceRef = sourceValue['sha']
        if (typeof sourceValue['path'] === 'string')
          sourcePath = sourceValue['path'].replace(/^\.\//u, '')
        else if (kind === 'url') sourcePath = ''
      } else if (kind === 'local' && typeof sourceValue['path'] === 'string') {
        sourcePath = sourceValue['path'].replace(/^\.\//u, '')
      } else {
        unsupportedReason =
          kind === 'npm'
            ? 'npm plugin packages are listed but cannot be installed yet.'
            : 'This package source is not a GitHub repository.'
      }
    }
    if (sourcePath.split('/').some((part) => part === '..')) return []
    const manifest = isRecord(entry['manifest']) ? entry['manifest'] : entry
    const interfaceData = isRecord(manifest['interface'])
      ? manifest['interface']
      : isRecord(entry['interface'])
        ? entry['interface']
        : {}
    const components: AgentPluginMarketEntry['components'] = []
    if (isRecord(manifest) && (manifest['skills'] || entry['skills'])) components.push('skills')
    if (isRecord(manifest) && (manifest['mcpServers'] || entry['mcpServers']))
      components.push('mcp')
    if (entry['hooks'] || manifest['hooks']) components.push('hooks')
    if (entry['agents']) components.push('agents')
    if (entry['commands']) components.push('commands')
    if (entry['apps']) components.push('apps')
    if (entry['lspServers']) components.push('lspServers')
    const stableId = `${platform}:${marketplaceId}:${name}`
    return [
      {
        id: stableId,
        name,
        displayName: cleanText(interfaceData['displayName'] ?? entry['displayName'], name, 120),
        description: cleanText(
          interfaceData['shortDescription'] ?? entry['description'],
          'Agent plugin',
          300
        ),
        version:
          typeof manifest['version'] === 'string'
            ? manifest['version']
            : typeof entry['version'] === 'string'
              ? entry['version']
              : null,
        publisher:
          cleanText(
            typeof manifest['author'] === 'string'
              ? manifest['author']
              : isRecord(manifest['author'])
                ? manifest['author']['name']
                : null,
            '',
            120
          ) || null,
        iconUrl:
          typeof interfaceData['icon'] === 'string'
            ? interfaceData['icon']
            : typeof manifest['icon'] === 'string'
              ? manifest['icon']
              : null,
        homepage: typeof manifest['homepage'] === 'string' ? manifest['homepage'] : null,
        source: { repository: sourceRepo, ref: sourceRef, path: sourcePath },
        components,
        ...(unsupportedReason ? { unsupportedReason } : {})
      }
    ]
  })
}

function marketId(platform: Platform, repository: string): string {
  return `${platform}:${repository.toLowerCase()}`
}

function isSupportedPackageFile(path: string): boolean {
  const segments = path.split('/')
  const filename = segments.at(-1)?.toLowerCase() ?? ''
  if (filename === '.env' || filename.startsWith('.env.')) return false
  if (segments.some((segment) => segment === '.git' || segment === 'node_modules')) return false
  return (
    /\.(?:json|jsonc|toml|ya?ml|md|mdx|txt|js|mjs|cjs|ts|tsx|jsx|py|sh|rb|go|rs|java|kt|swift|cs|css|html|xml|svg|sql|graphql|gql)$/iu.test(
      filename
    ) || ['license', 'notice', 'readme', 'makefile'].includes(filename)
  )
}

export class AgentPluginService {
  private marketplaceWrite: Promise<void> = Promise.resolve()
  private installedWrite: Promise<void> = Promise.resolve()
  private readonly candidateCache = new Map<
    string,
    { raw: string; candidates: PluginCandidate[] }
  >()

  constructor(private readonly storage: StorageEngine) {}

  private async marketplaces(): Promise<AgentPluginMarketplace[]> {
    return parseRecord<AgentPluginMarketplace>(
      await this.storage.readRaw(MARKETPLACES_FILE),
      'marketplaces'
    )
  }

  private async installed(): Promise<InstalledAgentPlugin[]> {
    return parseRecord<InstalledAgentPlugin>(await this.storage.readRaw(INSTALLED_FILE), 'plugins')
  }

  private async updateInstalled(
    mutate: (plugins: InstalledAgentPlugin[]) => InstalledAgentPlugin[]
  ): Promise<void> {
    const write = this.installedWrite.then(async () => {
      const plugins = await this.installed()
      await this.storage.write(INSTALLED_FILE, { plugins: mutate(plugins) })
    })
    this.installedWrite = write.then(
      () => undefined,
      () => undefined
    )
    await write
  }

  async listMarketplaces(): Promise<AgentPluginMarketplace[]> {
    if (!(await this.storage.readRaw(SEEDED_FILE))) {
      const current = new Set((await this.marketplaces()).map((marketplace) => marketplace.id))
      const missing = DEFAULT_MARKETPLACES.filter((marketplace) => {
        const repository = repoUrl(marketplace.url).repository
        return !current.has(marketId(marketplace.platform, repository))
      })
      await Promise.allSettled(missing.map((marketplace) => this.addMarketplace(marketplace)))
      const loaded = new Set((await this.marketplaces()).map((marketplace) => marketplace.id))
      if (
        DEFAULT_MARKETPLACES.every((marketplace) =>
          loaded.has(marketId(marketplace.platform, repoUrl(marketplace.url).repository))
        )
      ) {
        await this.storage.write(SEEDED_FILE, { completedAt: Date.now() })
      }
    }
    return this.marketplaces()
  }
  async listInstalled(): Promise<InstalledAgentPlugin[]> {
    return this.installed()
  }

  async addMarketplace(input: {
    url: string
    platform: Platform
  }): Promise<AgentPluginMarketplace> {
    const parsed = repoUrl(input.url)
    parsed.ref = await resolvedRef(parsed.repository, parsed.ref)
    const files =
      input.platform === 'codex'
        ? ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json']
        : ['.claude-plugin/marketplace.json']
    let payload: unknown = null
    let selected = ''
    for (const path of files) {
      try {
        payload = JSON.parse(await githubText(parsed.repository, parsed.ref, path))
        selected = path
        break
      } catch {
        /* Try the other supported marketplace manifest location. */
      }
    }
    if (!payload || !selected)
      throw new Error('No compatible Codex or Claude Code marketplace manifest was found')
    if (!isRecord(payload) || !Array.isArray(payload['plugins']))
      throw new TypeError('Marketplace manifest has no plugins list')
    const id = marketId(input.platform, parsed.repository)
    const marketplace: AgentPluginMarketplace = {
      id,
      name: cleanText(
        payload['name'] ??
          (isRecord(payload['interface']) ? payload['interface']['displayName'] : null),
        parsed.repository,
        120
      ),
      url: `${parsed.repository}${parsed.ref === 'HEAD' ? '' : `@${parsed.ref}`}`,
      platform: input.platform,
      pluginCount: payload['plugins'].length,
      refreshedAt: Date.now()
    }
    const write = this.marketplaceWrite.then(async () => {
      const entries = await this.marketplaces()
      const next = [...entries.filter((entry) => entry.id !== id), marketplace]
      await this.storage.writeRaw(
        `plugins/catalogs/${encodeURIComponent(id)}.json`,
        JSON.stringify({
          repository: parsed.repository,
          ref: parsed.ref,
          manifestPath: selected,
          payload
        })
      )
      await this.storage.write(MARKETPLACES_FILE, { marketplaces: next })
    })
    this.marketplaceWrite = write.then(
      () => undefined,
      () => undefined
    )
    await write
    return marketplace
  }

  async removeMarketplace(id: string): Promise<void> {
    const activeInstalls = (await this.installed()).filter((plugin) => plugin.marketplaceId === id)
    if (activeInstalls.length)
      throw new Error('Uninstall this marketplace’s plugins before removing the marketplace')
    const next = (await this.marketplaces()).filter((entry) => entry.id !== id)
    await this.storage.write(MARKETPLACES_FILE, { marketplaces: next })
    await this.storage.remove(`plugins/catalogs/${encodeURIComponent(id)}.json`)
  }

  async listEntries(
    query = '',
    offset = 0,
    limit = 40,
    view: 'discover' | 'bookmarks' | 'installed' = 'discover'
  ): Promise<AgentPluginMarketEntry[]> {
    const installed = await this.installed()
    const bookmarks = new Set(
      parseRecord<string>(await this.storage.readRaw(BOOKMARKS_FILE), 'ids')
    )
    const normalized = query.trim().toLocaleLowerCase()
    const output: AgentPluginMarketEntry[] = []
    for (const marketplace of await this.marketplaces()) {
      const raw = await this.storage.readRaw(
        `plugins/catalogs/${encodeURIComponent(marketplace.id)}.json`
      )
      if (!raw) continue
      let cached = this.candidateCache.get(marketplace.id)
      if (!cached || cached.raw !== raw) {
        const catalog: unknown = JSON.parse(raw)
        if (!isRecord(catalog) || !isRecord(catalog['payload'])) continue
        cached = {
          raw,
          candidates: marketplaceCandidates(
            catalog['payload'],
            marketplace.platform,
            marketplace.id,
            cleanText(catalog['repository'], ''),
            cleanText(catalog['ref'], 'HEAD')
          )
        }
        this.candidateCache.set(marketplace.id, cached)
      }
      const candidates = cached.candidates
      for (const candidate of candidates) {
        if (
          normalized &&
          !`${candidate.displayName} ${candidate.description} ${candidate.publisher ?? ''} ${candidate.name} ${candidate.id}`
            .toLocaleLowerCase()
            .includes(normalized)
        )
          continue
        const installedRecord = installed.find((plugin) => plugin.id === candidate.id)
        const bookmarked = bookmarks.has(candidate.id)
        if (view === 'bookmarks' && !bookmarked) continue
        if (view === 'installed' && !installedRecord) continue
        output.push({
          ...candidate,
          platform: marketplace.platform,
          marketplaceId: marketplace.id,
          installed: Boolean(installedRecord),
          updateAvailable: Boolean(
            installedRecord &&
            (candidate.version
              ? candidate.version !== installedRecord.version
              : candidate.source.ref !== 'HEAD' &&
                candidate.source.ref !== installedRecord.source.ref)
          ),
          bookmarked,
          supported: !candidate.unsupportedReason,
          ...(candidate.unsupportedReason
            ? { unsupportedReason: candidate.unsupportedReason }
            : {}),
          ...(installedRecord?.availableVersion
            ? { version: installedRecord.availableVersion }
            : {})
        })
      }
    }
    output.sort((a, b) => a.displayName.localeCompare(b.displayName))
    return output.slice(Math.max(0, offset), Math.max(0, offset) + Math.min(60, Math.max(1, limit)))
  }

  async getIcon(id: string): Promise<string | null> {
    const entry = (await this.listEntries(id)).find((candidate) => candidate.id === id)
    if (!entry?.iconUrl) return null
    let iconUrl: string
    try {
      const iconPath = entry.iconUrl.replace(/^\.\//u, '').replace(/^\//u, '')
      if (iconPath.split('/').includes('..')) return null
      const iconRef =
        entry.source.ref === 'HEAD'
          ? await resolvedRef(entry.source.repository, 'HEAD')
          : entry.source.ref
      iconUrl = !entry.iconUrl.startsWith('https://')
        ? `https://raw.githubusercontent.com/${entry.source.repository}/${encodeURIComponent(iconRef)}/${entry.source.path.replace(/\/$/u, '')}/${iconPath.split('/').map(encodeURIComponent).join('/')}`
        : new URL(entry.iconUrl).toString()
    } catch {
      return null
    }
    const url = new URL(iconUrl)
    if (
      url.protocol !== 'https:' ||
      !['raw.githubusercontent.com', 'github.com', 'avatars.githubusercontent.com'].includes(
        url.hostname
      )
    )
      return null
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) return null
      const contentType = response.headers.get('content-type')?.split(';')[0]?.toLowerCase()
      if (
        !contentType ||
        !['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'].includes(
          contentType
        )
      )
        return null
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > 256 * 1024) return null
      return `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`
    } catch {
      return null
    }
  }

  async setBookmarked(id: string, bookmarked: boolean): Promise<void> {
    const ids = new Set(parseRecord<string>(await this.storage.readRaw(BOOKMARKS_FILE), 'ids'))
    if (bookmarked) ids.add(id)
    else ids.delete(id)
    await this.storage.write(BOOKMARKS_FILE, { ids: [...ids].slice(-500) })
  }

  async install(id: string): Promise<InstalledAgentPlugin> {
    const entry = (await this.listEntries(id)).find((candidate) => candidate.id === id)
    if (!entry) throw new Error('Plugin is no longer in this marketplace')
    if (!entry.supported)
      throw new Error(entry.unsupportedReason ?? 'Plugin source is not supported')
    const sourceRef =
      entry.source.ref === 'HEAD'
        ? await resolvedRef(entry.source.repository, 'HEAD')
        : entry.source.ref
    const treePath = `/repos/${entry.source.repository}/git/trees/${encodeURIComponent(sourceRef)}?recursive=1`
    const treePayload = await githubJson(treePath)
    if (!isRecord(treePayload) || !Array.isArray(treePayload['tree']))
      throw new Error('Plugin repository tree is invalid')
    const prefix = entry.source.path.replace(/^\//u, '').replace(/\/$/u, '')
    const files = (treePayload['tree'] as unknown[]).flatMap((item): GitTreeEntry[] => {
      if (!isRecord(item) || item['type'] !== 'blob' || typeof item['path'] !== 'string') return []
      const path = item['path']
      if (!isSupportedPackageFile(path)) return []
      if (prefix && path !== prefix && !path.startsWith(`${prefix}/`)) return []
      if (path.split('/').some((segment) => segment === '..')) return []
      return [
        { path, type: 'blob', ...(typeof item['size'] === 'number' ? { size: item['size'] } : {}) }
      ]
    })
    if (!files.length || files.length > MAX_PLUGIN_FILES)
      throw new Error('Plugin must contain between 1 and 300 files')
    const totalBytes = files.reduce((sum, file) => sum + (file.size ?? 0), 0)
    if (totalBytes > MAX_PLUGIN_BYTES)
      throw new Error('Plugin package exceeds the 8 MB install limit')
    const packageVersion = entry.version ?? sourceRef
    const pluginHash = createHash('sha256')
      .update(`${entry.id}:${packageVersion}`)
      .digest('hex')
      .slice(0, 20)
    const relativePath = join('plugins', 'packages', pluginHash)
    const filesByPath = new Map<string, string>()
    let downloadedBytes = 0
    for (let offset = 0; offset < files.length; offset += 4) {
      const batch = files.slice(offset, offset + 4)
      const downloaded = await Promise.all(
        batch.map(async (file) => ({
          file,
          contents: await githubText(
            entry.source.repository,
            sourceRef,
            file.path,
            MAX_PLUGIN_FILE_BYTES
          )
        }))
      )
      for (const { file, contents } of downloaded) {
        downloadedBytes += Buffer.byteLength(contents, 'utf8')
        if (downloadedBytes > MAX_PLUGIN_BYTES) {
          throw new Error('Plugin package exceeds the 8 MB install limit')
        }
        const relative = file.path.slice(prefix.length).replace(/^\//u, '')
        filesByPath.set(relative, contents)
        await this.storage.writeRaw(join(relativePath, relative), contents)
      }
    }
    const manifestText =
      filesByPath.get('plugin.json') ??
      filesByPath.get('.codex-plugin/plugin.json') ??
      filesByPath.get('.claude-plugin/plugin.json')
    const manifest = manifestText ? (JSON.parse(manifestText) as unknown) : {}
    if (!isRecord(manifest)) throw new Error('Plugin manifest is invalid')
    const utilities: UtilityDefinitionInput[] = []
    const rootDir = this.storage.resolve(relativePath)
    const skills = [...filesByPath.entries()].filter(([path]) =>
      /^skills\/[^/]+\/SKILL\.md$/u.test(path)
    )
    for (const [path, markdown] of skills) {
      const skillName = path.split('/')[1] ?? entry.name
      const title = markdown.match(/^name:\s*([\w.-]+)/mu)?.[1] ?? skillName
      const description =
        markdown.match(/^description:\s*(.+)$/mu)?.[1]?.trim() ?? `Skill from ${entry.displayName}`
      utilities.push({
        kind: 'skill',
        name: `${entry.name}: ${title}`,
        description,
        enabled: true,
        activation: 'on_demand',
        config: { instructions: markdown },
        harnessBindings: [
          { harnessId: '*', strategy: 'skill', transportName: `${entry.name}-${skillName}` }
        ]
      })
    }
    for (const configPath of ['mcp.json', '.mcp.json']) {
      const configText = filesByPath.get(configPath)
      if (!configText) continue
      const parsed: unknown = JSON.parse(configText)
      if (!isRecord(parsed) || !isRecord(parsed['mcpServers'])) continue
      for (const [serverName, value] of Object.entries(parsed['mcpServers'])) {
        if (!isRecord(value)) continue
        const command = value['command']
        const args = Array.isArray(value['args'])
          ? value['args'].filter((arg): arg is string => typeof arg === 'string')
          : []
        const url = value['url']
        const env = isRecord(value['env'])
          ? Object.fromEntries(
              Object.entries(value['env']).filter(
                (pair): pair is [string, string] => typeof pair[1] === 'string'
              )
            )
          : {}
        const replaceRoot = (part: string) =>
          part.replaceAll('${CLAUDE_PLUGIN_ROOT}', rootDir).replaceAll('${PLUGIN_ROOT}', rootDir)
        const replaceEnvReferences = (part: string) =>
          replaceRoot(part)
            .replaceAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, '{env:$1}')
            .replaceAll(/\$([A-Za-z_][A-Za-z0-9_]*)/gu, '{env:$1}')
        let config: McpUtilityConfig
        if (typeof url === 'string') {
          const headers = isRecord(value['headers'])
            ? Object.fromEntries(
                Object.entries(value['headers'])
                  .filter((pair): pair is [string, string] => typeof pair[1] === 'string')
                  .map(([key, item]) => [key, replaceEnvReferences(item)])
              )
            : undefined
          config = {
            transport: value['type'] === 'sse' ? 'sse' : 'http',
            url: replaceEnvReferences(url),
            ...(headers && Object.keys(headers).length ? { headers } : {})
          }
        } else {
          if (typeof command !== 'string') continue
          config = {
            transport: 'stdio',
            command: replaceRoot(command),
            args: args.map(replaceRoot),
            environment: Object.fromEntries(
              Object.entries(env).map(([key, item]) => [key, replaceEnvReferences(item)])
            )
          }
        }
        utilities.push({
          kind: 'mcp',
          name: `${entry.name}: ${serverName}`,
          description: `Tools from ${entry.displayName}`,
          enabled: true,
          activation: 'on_demand',
          config,
          harnessBindings: [
            { harnessId: '*', strategy: 'mcp', transportName: `${entry.name}-${serverName}` }
          ]
        })
      }
    }
    if (utilities.length === 0) throw new Error('This plugin has no supported skills or MCP tools')
    const requiredCredentialVariables = new Set<string>()
    for (const utility of utilities) {
      if (utility.kind !== 'mcp') continue
      const config = utility.config as McpUtilityConfig
      const configuredValues = [
        ...Object.values(config.environment ?? {}),
        ...Object.values(config.headers ?? {})
      ]
      for (const value of configuredValues) {
        for (const match of value.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gu)) {
          if (match[1]) requiredCredentialVariables.add(match[1])
        }
      }
    }
    const unsupportedComponents: string[] = []
    for (const component of ['hooks', 'agents', 'commands'])
      if (entry.components.includes(component as AgentPluginMarketEntry['components'][number]))
        unsupportedComponents.push(component)
    for (const component of ['apps', 'lspServers'])
      if (entry.components.includes(component as AgentPluginMarketEntry['components'][number]))
        unsupportedComponents.push(component)
    const installedPlugin: InstalledAgentPlugin = {
      id: entry.id,
      name: entry.name,
      displayName: entry.displayName,
      description: entry.description,
      version: typeof manifest['version'] === 'string' ? manifest['version'] : entry.version,
      platform: entry.platform,
      marketplaceId: entry.marketplaceId,
      source: { ...entry.source, ref: sourceRef },
      installPath: this.storage.resolve(relativePath),
      utilityIds: [],
      requiredCredentialVariables: [...requiredCredentialVariables],
      installedAt: Date.now(),
      updatedAt: null,
      availableVersion: null,
      unsupportedComponents
    }
    const registry = new UtilityRegistryService(this.storage)
    const created = await registry.createMany(utilities)
    installedPlugin.utilityIds = created.map((utility) => utility.id)
    await this.updateInstalled((current) => [
      ...current.filter((plugin) => plugin.id !== id),
      installedPlugin
    ])
    return installedPlugin
  }

  async uninstall(id: string): Promise<void> {
    const installed = await this.installed()
    const plugin = installed.find((candidate) => candidate.id === id)
    if (!plugin) return
    const registry = new UtilityRegistryService(this.storage)
    for (const utilityId of plugin.utilityIds) await registry.delete(utilityId)
    const packageName = plugin.installPath.split(/[\\/]/u).pop()
    if (packageName && /^[a-f0-9]{20}$/u.test(packageName))
      await this.storage.remove(`plugins/packages/${packageName}`)
    await this.updateInstalled((current) => current.filter((candidate) => candidate.id !== id))
  }

  async update(id: string): Promise<InstalledAgentPlugin> {
    const previous = (await this.installed()).find((plugin) => plugin.id === id)
    if (!previous) throw new Error('Plugin is not installed')
    const next = await this.install(id)
    const registry = new UtilityRegistryService(this.storage)
    for (const utilityId of previous.utilityIds) await registry.delete(utilityId)
    if (previous.installPath !== next.installPath) {
      const packageName = previous.installPath.split(/[\\/]/u).pop()
      if (packageName && /^[a-f0-9]{20}$/u.test(packageName))
        await this.storage.remove(`plugins/packages/${packageName}`)
    }
    const updated = { ...next, installedAt: previous.installedAt, updatedAt: Date.now() }
    await this.updateInstalled((records) =>
      records.map((plugin) => (plugin.id === id ? updated : plugin))
    )
    return updated
  }
}
