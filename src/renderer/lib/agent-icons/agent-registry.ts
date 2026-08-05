import { publicAssetUrl } from '../static-assets'

export interface AgentIconMetadata {
  id: string
  name: string
  vendor: string
  website: string
  icon: string
  monochrome?: string
  primaryColor?: string
  aliases?: readonly string[]
}

export interface AgentIconEntry extends AgentIconMetadata {
  iconUrl: string
  monochromeUrl?: string
}

export function normalizeAgentIconId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
}

export function parseAgentIconMetadata(value: unknown): AgentIconMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  const required = ['id', 'name', 'vendor', 'website', 'icon'] as const
  if (required.some((key) => typeof candidate[key] !== 'string' || !candidate[key].trim()))
    return undefined
  if (typeof candidate.monochrome !== 'undefined' && typeof candidate.monochrome !== 'string')
    return undefined
  if (typeof candidate.primaryColor !== 'undefined' && typeof candidate.primaryColor !== 'string')
    return undefined
  if (
    typeof candidate.aliases !== 'undefined' &&
    (!Array.isArray(candidate.aliases) ||
      candidate.aliases.some((alias) => typeof alias !== 'string'))
  )
    return undefined

  return {
    id: normalizeAgentIconId(candidate.id as string),
    name: candidate.name as string,
    vendor: candidate.vendor as string,
    website: candidate.website as string,
    icon: candidate.icon as string,
    monochrome: candidate.monochrome as string | undefined,
    primaryColor: candidate.primaryColor as string | undefined,
    aliases: candidate.aliases as string[] | undefined
  }
}

export function buildAgentIconEntry(metadata: AgentIconMetadata): AgentIconEntry {
  const baseUrl = `/assets/agents/${metadata.id}/`
  const resolveIconUrl = (path: string): string =>
    publicAssetUrl(new URL(path, `https://app.local${baseUrl}`).pathname)

  return {
    ...metadata,
    aliases: metadata.aliases?.map(normalizeAgentIconId),
    iconUrl: resolveIconUrl(metadata.icon),
    monochromeUrl: metadata.monochrome ? resolveIconUrl(metadata.monochrome) : undefined
  }
}
