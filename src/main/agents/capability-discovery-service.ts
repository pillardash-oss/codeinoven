import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type {
  AgentCapabilityCatalog,
  AgentCapabilityEntry,
  AgentCapabilityOrigin,
  AgentCapabilitySource,
  NativeMcpContent,
  NativeSkillContent
} from '../../lib/types'

interface McpServer {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  url?: string
  environment?: Record<string, string>
  headers?: Record<string, string>
  enabled: boolean
}

interface HarnessSpec {
  id: string
  /** Config files (JSON/TOML) that can declare MCP servers, relative to home. */
  globalConfigPaths: string[]
  /** Same, relative to the project root. */
  projectConfigPaths: string[]
  /** Skill folders that may contain SKILL.md directories, relative to home. */
  globalSkillDirs: string[]
  /** Same, relative to the project root. */
  projectSkillDirs: string[]
  /** Which config shape the harness uses for MCP servers. */
  mcpFormat: 'opencode' | 'mcpServers' | 'codex-toml'
}

const SHARED_GLOBAL_SKILL_DIR = '.agents/skills'
const SHARED_PROJECT_SKILL_DIR = '.agents/skills'

const HARNESS_SPECS: Record<string, HarnessSpec> = {
  opencode: {
    id: 'opencode',
    globalConfigPaths: ['.config/opencode/opencode.json'],
    projectConfigPaths: ['.opencode/opencode.json', 'opencode.json'],
    globalSkillDirs: ['.config/opencode/skills'],
    projectSkillDirs: ['.opencode/skills'],
    mcpFormat: 'opencode'
  },
  'claude-code': {
    id: 'claude-code',
    globalConfigPaths: ['.claude.json'],
    projectConfigPaths: ['.mcp.json', '.claude/settings.json'],
    globalSkillDirs: ['.claude/skills'],
    projectSkillDirs: ['.claude/skills'],
    mcpFormat: 'mcpServers'
  },
  codex: {
    id: 'codex',
    globalConfigPaths: ['.codex/config.toml'],
    projectConfigPaths: ['.codex/config.toml'],
    globalSkillDirs: ['.codex/skills'],
    projectSkillDirs: ['.codex/skills'],
    mcpFormat: 'codex-toml'
  },
  cline: {
    id: 'cline',
    globalConfigPaths: ['.cline/data/settings/cline_mcp_settings.json'],
    projectConfigPaths: ['.cline/mcp_settings.json'],
    globalSkillDirs: ['.cline/skills'],
    projectSkillDirs: ['.cline/skills'],
    mcpFormat: 'mcpServers'
  },
  pi: {
    id: 'pi',
    globalConfigPaths: [],
    projectConfigPaths: [],
    globalSkillDirs: [],
    projectSkillDirs: ['.pi/skills'],
    mcpFormat: 'mcpServers'
  },
  antigravity: {
    id: 'antigravity',
    globalConfigPaths: ['.gemini/config/mcp_config.json'],
    projectConfigPaths: ['.agents/mcp_config.json'],
    globalSkillDirs: [],
    projectSkillDirs: [],
    mcpFormat: 'mcpServers'
  },
  muse: {
    id: 'muse',
    globalConfigPaths: ['.config/muse/settings.json'],
    projectConfigPaths: ['.muse/mcp.json'],
    globalSkillDirs: ['.config/muse/skills'],
    projectSkillDirs: ['.muse/skills'],
    mcpFormat: 'mcpServers'
  }
}

const DEFAULT_SPEC: HarnessSpec = {
  id: 'pi',
  globalConfigPaths: [],
  projectConfigPaths: [],
  globalSkillDirs: [],
  projectSkillDirs: ['.pi/skills'],
  mcpFormat: 'mcpServers'
}

interface DiscoveryResult {
  mcp: AgentCapabilityEntry[]
  skill: AgentCapabilityEntry[]
}

interface SkillLocation {
  path: string
  origin: AgentCapabilityOrigin
}

/** Optional ownership metadata attached to catalog entries surfaced by `discoverAll`. */
interface CapabilityAttribution {
  harnessId?: string
  projectId?: string
}

/**
 * Reads the harness-native MCP servers and skills that are actually loaded for
 * one project (global config, harness skills folders, and the shared
 * agents/skills directory). App-managed utilities are merged by the caller.
 *
 * Origins:
 * - `harness`  → items that belong to one harness's own directories/configs.
 * - `global`   → the shared agents/skills folder, available to every harness.
 * - `application` → CodeInOven registry utilities (merged by chat-engine).
 */
export class CapabilityDiscoveryService {
  async discover(projectPath: string, harnessId: string): Promise<DiscoveryResult> {
    const spec = HARNESS_SPECS[harnessId] ?? DEFAULT_SPEC
    const home = homedir()
    const mcp: AgentCapabilityEntry[] = []
    const skill: AgentCapabilityEntry[] = []

    for (const configPath of spec.globalConfigPaths) {
      mcp.push(...(await this.readMcpConfig(join(home, configPath), 'harness', spec.mcpFormat)))
    }
    for (const configPath of spec.projectConfigPaths) {
      mcp.push(
        ...(await this.readMcpConfig(join(projectPath, configPath), 'harness', spec.mcpFormat))
      )
    }

    const skillDirs: SkillLocation[] = [
      ...spec.globalSkillDirs.map((dir) => ({
        path: join(home, dir),
        origin: 'harness' as const
      })),
      { path: join(home, SHARED_GLOBAL_SKILL_DIR), origin: 'global' as const },
      ...spec.projectSkillDirs.map((dir) => ({
        path: join(projectPath, dir),
        origin: 'harness' as const
      })),
      { path: join(projectPath, SHARED_PROJECT_SKILL_DIR), origin: 'global' as const }
    ]
    for (const { path, origin } of skillDirs) {
      skill.push(...(await this.scanSkillDir(path, origin)))
    }

    return { mcp: dedupe(mcp), skill: dedupe(skill) }
  }

  /**
   * Settings-level catalog: every skill and MCP server the app can see across
   * all installed harnesses, the shared global layer, and every registered
   * local project. Entries are attributed with the owning harness/project so
   * the Utilities page can group by harness, global, or project — entries are
   * intentionally NOT name-deduped here because the same capability may be
   * installed for several harnesses at once.
   */
  async discoverAll(
    projects: Array<{ id: string; path: string }>
  ): Promise<AgentCapabilityCatalog> {
    const home = homedir()
    const mcp: AgentCapabilityEntry[] = []
    const skill: AgentCapabilityEntry[] = []
    const specs = Object.values(HARNESS_SPECS)

    for (const spec of specs) {
      const attribution: CapabilityAttribution = { harnessId: spec.id }
      for (const configPath of spec.globalConfigPaths) {
        mcp.push(
          ...(await this.readMcpConfig(
            join(home, configPath),
            'harness',
            spec.mcpFormat,
            attribution
          ))
        )
      }
      for (const dir of spec.globalSkillDirs) {
        skill.push(...(await this.scanSkillDir(join(home, dir), 'harness', attribution)))
      }
      for (const project of projects) {
        const projectAttribution: CapabilityAttribution = {
          harnessId: spec.id,
          projectId: project.id
        }
        for (const configPath of spec.projectConfigPaths) {
          mcp.push(
            ...(await this.readMcpConfig(
              join(project.path, configPath),
              'harness',
              spec.mcpFormat,
              projectAttribution
            ))
          )
        }
        for (const dir of spec.projectSkillDirs) {
          skill.push(
            ...(await this.scanSkillDir(join(project.path, dir), 'harness', projectAttribution))
          )
        }
      }
    }

    skill.push(...(await this.scanSkillDir(join(home, SHARED_GLOBAL_SKILL_DIR), 'global')))
    for (const project of projects) {
      skill.push(
        ...(await this.scanSkillDir(join(project.path, SHARED_PROJECT_SKILL_DIR), 'global', {
          projectId: project.id
        }))
      )
    }

    return { mcp, skill }
  }

  async readSkill(source: AgentCapabilitySource): Promise<NativeSkillContent | null> {
    if (source.kind !== 'skill') return null
    const markdown = await readTextFile(join(source.path, 'SKILL.md'))
    if (!markdown) return null
    const { name, description } = parseSkillFrontmatter(markdown, basename(source.path))
    return {
      name,
      description,
      instructions: markdown,
      path: source.path
    }
  }

  async updateSkill(source: AgentCapabilitySource, instructions: string): Promise<boolean> {
    if (source.kind !== 'skill') return false
    if (!instructions.trim()) return false
    const skillPath = source.path
    try {
      await writeFile(join(skillPath, 'SKILL.md'), instructions, 'utf8')
      return true
    } catch {
      return false
    }
  }

  async deleteSkill(source: AgentCapabilitySource): Promise<boolean> {
    if (source.kind !== 'skill') return false
    try {
      await rm(source.path, { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }

  async readMcp(source: AgentCapabilitySource): Promise<NativeMcpContent | null> {
    if (source.kind !== 'mcp') return null
    const raw = await readTextFile(source.configPath)
    if (!raw) return null
    try {
      const server = parseMcpFile(source.configPath, source.format, source.serverName, raw)
      if (!server) return null
      return {
        name: server.name,
        transport: server.transport,
        command: server.command,
        args: server.args,
        url: server.url,
        environment: server.environment,
        headers: server.headers,
        enabled: server.enabled,
        configPath: source.configPath
      }
    } catch {
      return null
    }
  }

  async updateMcp(source: AgentCapabilitySource, content: NativeMcpContent): Promise<boolean> {
    if (source.kind !== 'mcp') return false
    const raw = await readTextFile(source.configPath)
    if (!raw) return false
    try {
      const updated = rewriteMcpEntry(
        source.configPath,
        source.format,
        source.serverName,
        raw,
        content
      )
      if (!updated) return false
      await writeFile(source.configPath, updated, 'utf8')
      return true
    } catch {
      return false
    }
  }

  async deleteMcp(source: AgentCapabilitySource): Promise<boolean> {
    if (source.kind !== 'mcp') return false
    const raw = await readTextFile(source.configPath)
    if (!raw) return false
    try {
      const updated = removeMcpEntry(source.configPath, source.format, source.serverName, raw)
      if (updated === null) return false
      await writeFile(source.configPath, updated, 'utf8')
      return true
    } catch {
      return false
    }
  }

  private async readMcpConfig(
    absolutePath: string,
    origin: AgentCapabilityOrigin,
    format: HarnessSpec['mcpFormat'],
    attribution: CapabilityAttribution = {}
  ): Promise<AgentCapabilityEntry[]> {
    const raw = await readTextFile(absolutePath)
    if (!raw) return []
    try {
      const servers = parseMcpFileEntries(format, raw)
      return servers.map((server) => {
        const source: AgentCapabilitySource = {
          kind: 'mcp',
          configPath: absolutePath,
          format,
          serverName: server.name
        }
        return {
          id: `${origin}:mcp:${absolutePath}:${server.name}`,
          name: server.name,
          kind: 'mcp' as const,
          origin,
          enabled: server.enabled,
          detail:
            server.transport === 'stdio'
              ? `stdio · ${server.command ?? ''}`
              : `${server.transport} · ${server.url ?? ''}`,
          source,
          harnessId: attribution.harnessId,
          projectId: attribution.projectId
        }
      })
    } catch {
      // Malformed or unsupported config — report nothing rather than failing the panel.
      return []
    }
  }

  private async scanSkillDir(
    absolutePath: string,
    origin: AgentCapabilityOrigin,
    attribution: CapabilityAttribution = {}
  ): Promise<AgentCapabilityEntry[]> {
    let entries: Dirent[]
    try {
      entries = await readdir(absolutePath, { withFileTypes: true })
    } catch {
      return []
    }
    const skills: AgentCapabilityEntry[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillPath = join(absolutePath, entry.name)
      const markdown = await readTextFile(join(skillPath, 'SKILL.md'))
      if (!markdown) continue
      const source: AgentCapabilitySource = { kind: 'skill', path: skillPath }
      skills.push({
        id: `${origin}:skill:${skillPath}`,
        name: parseSkillFrontmatter(markdown, entry.name).name,
        kind: 'skill',
        origin,
        enabled: true,
        description: parseSkillFrontmatter(markdown, entry.name).description,
        detail: skillPath,
        source,
        harnessId: attribution.harnessId,
        projectId: attribution.projectId
      })
    }
    return skills
  }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function parseSkillFrontmatter(
  markdown: string,
  fallback: string
): { name: string; description: string } {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) return { name: fallback, description: '' }
  const fields: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    fields[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim()
  }
  return { name: fields['name'] || fallback, description: fields['description'] ?? '' }
}

function parseMcpFileEntries(format: HarnessSpec['mcpFormat'], raw: string): McpServer[] {
  if (format === 'codex-toml') return parseTomlMcpServers(raw)
  return parseMcpServersJson(JSON.parse(raw))
}

function parseMcpFile(
  configPath: string,
  format: HarnessSpec['mcpFormat'],
  serverName: string,
  raw: string
): McpServer | null {
  const entries = parseMcpFileEntries(format, raw)
  return entries.find((server) => server.name === serverName) ?? null
}

function rewriteMcpEntry(
  configPath: string,
  format: HarnessSpec['mcpFormat'],
  serverName: string,
  raw: string,
  content: NativeMcpContent
): string | null {
  if (format === 'codex-toml') {
    return rewriteTomlMcpEntry(serverName, raw, content)
  }
  return rewriteJsonMcpEntry(configPath, format, serverName, raw, content)
}

function rewriteJsonMcpEntry(
  configPath: string,
  format: HarnessSpec['mcpFormat'],
  serverName: string,
  raw: string,
  content: NativeMcpContent
): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const containerKey = format === 'opencode' ? 'mcp' : format === 'mcpServers' ? 'mcpServers' : null
  if (!containerKey) return null
  const container = parsed[containerKey]
  if (!isRecord(container)) return null
  if (content.transport === 'stdio' && content.command) {
    container[serverName] = {
      command: content.command,
      ...(content.args && content.args.length ? { args: content.args } : {}),
      ...(content.environment && Object.keys(content.environment).length
        ? { env: content.environment }
        : {}),
      ...(format === 'opencode' ? { enabled: content.enabled } : {})
    }
  } else if (content.transport !== 'stdio' && content.url) {
    container[serverName] = {
      type: content.transport === 'sse' ? 'sse' : 'http',
      url: content.url,
      ...(content.headers && Object.keys(content.headers).length
        ? { headers: content.headers }
        : {}),
      ...(format === 'opencode' ? { enabled: content.enabled } : {})
    }
  } else {
    return null
  }
  return `${JSON.stringify(parsed, null, 2)}\n`
}

function removeMcpEntry(
  configPath: string,
  format: HarnessSpec['mcpFormat'],
  serverName: string,
  raw: string
): string | null {
  if (format === 'codex-toml') {
    return removeTomlMcpEntry(serverName, raw)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const containerKey = format === 'opencode' ? 'mcp' : format === 'mcpServers' ? 'mcpServers' : null
  if (!containerKey) return null
  const container = parsed[containerKey]
  if (!isRecord(container) || !(serverName in container)) return null
  delete container[serverName]
  return `${JSON.stringify(parsed, null, 2)}\n`
}

function parseMcpServersJson(raw: unknown): McpServer[] {
  if (!isRecord(raw)) return []
  const servers = raw['mcpServers'] ?? raw['mcp']
  if (!isRecord(servers)) return []
  return Object.entries(servers)
    .map(([name, value]): McpServer | null => {
      const def = isRecord(value) ? value : {}
      const type = def['type']
      const url = def['url'] ?? def['serverUrl']
      if (type === 'http' || type === 'sse' || typeof url === 'string') {
        return {
          name,
          transport: type === 'sse' ? 'sse' : 'http',
          url: String(url ?? ''),
          headers: stringMap(def['headers']),
          enabled: def['enabled'] !== false
        }
      }
      const command = String(def['command'] ?? '')
      const args = Array.isArray(def['args'])
        ? def['args'].map(String)
        : typeof def['args'] === 'string'
          ? [def['args']]
          : []
      if (!command && args.length === 0) return null
      return {
        name,
        transport: 'stdio',
        command,
        args,
        environment: stringMap(def['env']),
        enabled: def['enabled'] !== false
      }
    })
    .filter((server): server is McpServer => server !== null)
}

function parseTomlMcpServers(raw: string): McpServer[] {
  const servers: McpServer[] = []
  let current: McpServer | null = null
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const section = trimmed.match(/^\[([^\]]+)\]$/u)
    if (section) {
      const sectionName = section[1]?.trim() ?? ''
      const isServerSection = /^mcp_servers\.[^.\]]+$/u.test(sectionName)
      if (isServerSection) {
        current = {
          name: sectionName.slice('mcp_servers.'.length),
          transport: 'stdio',
          enabled: true
        }
        servers.push(current)
      } else {
        current = null
      }
      continue
    }
    if (!current) continue
    const equalIndex = trimmed.indexOf('=')
    if (equalIndex < 0) continue
    const key = trimmed.slice(0, equalIndex).trim()
    const value = trimmed.slice(equalIndex + 1).trim()
    if (key === 'command') current.command = unquoteToml(value)
    else if (key === 'args') current.args = parseTomlStringArray(value)
    else if (key === 'url') {
      current.url = unquoteToml(value)
      current.transport = 'http'
    } else if (key === 'enabled') {
      current.enabled = value === 'true'
    }
  }
  return servers.filter((server) => server.command || server.url)
}

function rewriteTomlMcpEntry(
  serverName: string,
  raw: string,
  content: NativeMcpContent
): string | null {
  const lines = raw.split(/\r?\n/u)
  const sectionHeader = `[mcp_servers.${serverName}]`
  const start = lines.findIndex((line) => line.trim() === sectionHeader)
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length) {
    const candidate = lines[end].trim()
    if (candidate.startsWith('[') || (!candidate && end > start + 1)) break
    end += 1
  }
  const header = lines[start] ?? sectionHeader
  const block: string[] = [header]
  if (content.transport === 'stdio' && content.command) {
    block.push(`command = ${tomlQuote(content.command)}`)
    if (content.args && content.args.length) {
      block.push(`args = ${tomlQuoteArray(content.args)}`)
    }
  } else if (content.transport !== 'stdio' && content.url) {
    block.push(`url = ${tomlQuote(content.url)}`)
  } else {
    return null
  }
  block.push(`enabled = ${content.enabled ? 'true' : 'false'}`)
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n')
}

function removeTomlMcpEntry(serverName: string, raw: string): string | null {
  const lines = raw.split(/\r?\n/u)
  const sectionHeader = `[mcp_servers.${serverName}]`
  let start = lines.findIndex((line) => line.trim() === sectionHeader)
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length) {
    const candidate = lines[end].trim()
    if (candidate.startsWith('[') || (!candidate && end > start + 1)) break
    end += 1
  }
  while (start > 0 && lines[start - 1].trim() === '') start -= 1
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n')
}

function unquoteToml(value: string): string {
  const double = value.match(/^"(.*)"$/su)
  if (double) return double[1] ?? ''
  const single = value.match(/^'(.*)'$/su)
  if (single) return single[1] ?? ''
  return value
}

function tomlQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function tomlQuoteArray(values: string[]): string {
  return `[${values.map((value) => tomlQuote(value)).join(', ')}]`
}

function parseTomlStringArray(value: string): string[] {
  const inner = value.trim()
  if (!inner.startsWith('[') || !inner.endsWith(']')) return []
  const body = inner.slice(1, -1)
  return body
    .split(',')
    .map((item) => unquoteToml(item.trim()))
    .filter(Boolean)
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') result[key] = item
  }
  return Object.keys(result).length ? result : undefined
}

function dedupe(entries: AgentCapabilityEntry[]): AgentCapabilityEntry[] {
  const seen = new Set<string>()
  const result: AgentCapabilityEntry[] = []
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.name.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(entry)
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
