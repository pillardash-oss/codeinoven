/**
 * Bundle brand icons (model vendors + agent harnesses) from the MIT-licensed
 * `@lobehub/icons-static-svg` package. Never fetch brand artwork from a CDN
 * at runtime — rerun `bun scripts/generate-brand-icons.ts` to refresh or
 * extend the sets.
 *
 * Vendors → `src/renderer/lib/vendor-icons/icons/` (build-time `?raw`
 * inlining, so `fill="currentColor"` marks follow the theme).
 *
 * Agent SVGs → `src/renderer/static/assets/agents/<id>/icon.svg` + `mono.svg`,
 * served as static files through `<img>`. Agent metadata →
 * `src/renderer/lib/agent-icons/agents/<id>/metadata.json`, imported by the
 * registry. `<img>` can't resolve `currentColor`, so the agent's `primaryColor`
 * from `metadata.json` is baked into mono marks at copy time.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Logger } from '../src/main/system/logger'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(root, 'node_modules/@lobehub/icons-static-svg/icons')

// ─── Vendors ────────────────────────────────────────────────────────────────

const vendorOutDir = join(root, 'src/renderer/lib/vendor-icons/icons')

/** Lobehub icon slugs of the model vendors we bundle. */
const vendorSlugs = [
  'ai21',
  'anthropic',
  'apple',
  'aws',
  'claudecode',
  'cline',
  'cloudflare',
  'codex',
  'azure',
  'baichuan',
  'bedrock',
  'claude',
  'cohere',
  'copilot',
  'deepmind',
  'deepseek',
  'doubao',
  'fireworks',
  'gemini',
  'github',
  'githubcopilot',
  'google',
  'grok',
  'groq',
  'huggingface',
  'kimi',
  'lmstudio',
  'meta',
  'microsoft',
  'minimax',
  'mistral',
  'moonshot',
  'nvidia',
  'ollama',
  'openai',
  'openrouter',
  'perplexity',
  'qwen',
  'stability',
  'together',
  'v0',
  'vercel',
  'xai',
  'yi',
  'zai',
  'zeroone',
  'zhipu'
] as const

/**
 * Provider marks that must render as theme-following monochrome (the source
 * also ships a `-color` variant, which resolveSource would otherwise prefer).
 * Anthropic → Claude Code, OpenAI → Codex: the harness marks are their canonical
 * provider icons, so the mono variant keeps them inheriting the surrounding
 * text color like the vendor icons they replace.
 */
const monoOnlyVendors = new Set<string>(['claudecode', 'codex'])

/** Source path for a slug, preferring the brand-colored variant. */
function resolveSource(slug: string): string | null {
  const colorSource = join(sourceDir, `${slug}-color.svg`)
  if (!monoOnlyVendors.has(slug) && existsSync(colorSource)) return colorSource
  const monoSource = join(sourceDir, `${slug}.svg`)
  if (existsSync(monoSource)) return monoSource
  return null
}

mkdirSync(vendorOutDir, { recursive: true })
const managedVendorFiles = new Set(
  vendorSlugs
    .map((slug) => `${slug}.svg`)
    .concat(['opencode.svg', 'cio.svg'])
)
for (const stale of readdirSync(vendorOutDir)) {
  if (managedVendorFiles.has(stale)) unlinkSync(join(vendorOutDir, stale))
}

const missingVendors: string[] = []
let copiedVendors = 0

for (const slug of vendorSlugs) {
  const source = resolveSource(slug)
  if (!source) {
    missingVendors.push(slug)
    continue
  }
  copyFileSync(source, join(vendorOutDir, `${slug}.svg`))
  copiedVendors += 1
}

Logger.dev(`[generate-brand-icons] Copied ${copiedVendors} vendor icons to ${vendorOutDir}.`)
if (missingVendors.length > 0) {
  Logger.dev(`[generate-brand-icons] Missing vendor slugs: ${missingVendors.join(', ')}`)
}

// Opencode also appears as a model provider (opencode zen / opencode go), but
// lobehub still ships its outdated logo. Reuse the hand-vendored agent mark as
// the single source of truth, sized to `1em` for inline vendor rendering.
const opencodeMark = readFileSync(
  join(root, 'src/renderer/static/assets/agents/opencode/icon.svg'),
  'utf8'
)
writeFileSync(
  join(vendorOutDir, 'opencode.svg'),
  opencodeMark.replace('<svg ', '<svg width="1em" height="1em" ')
)
Logger.dev(`[generate-brand-icons] Wrote vendored opencode mark to ${vendorOutDir}.`)

// CodeInOven is a citizen of its own bundle — its vendor mark is the bare
// transparent oven+code artwork (`icon-mark.svg`), whose strokes use
// `currentColor` so the mark follows the surrounding text color (white on
// dark surfaces, black on light) exactly like the other mono vendor marks.
// The squircle-tile app icon (`icon.svg`) is platform artwork only and is
// NOT used here. Serves the model picker, custom `cio-` providers, and the
// about-screen identity/link rows.
let cioMark = readFileSync(join(root, 'src/renderer/static/icon-mark.svg'), 'utf8')
cioMark = cioMark
  .replace(/^<\?[\s\S]*?\?>\s*/i, '')
  .replace(/^<!--[\s\S]*?-->\s*/, '')
  .replace('<svg ', '<svg width="1em" height="1em" ')
  .replace(/(<svg[^>]*>)/, '$1<title>CodeInOven</title>')
writeFileSync(join(vendorOutDir, 'cio.svg'), cioMark)
Logger.dev(`[generate-brand-icons] Wrote vendored CodeInOven mark to ${vendorOutDir}.`)

// ─── Agents ─────────────────────────────────────────────────────────────────

/** Where agent SVGs are served from as static files. */
const agentsStaticDir = join(root, 'src/renderer/static/assets/agents')
/** Where agent metadata is imported from by the icon registry. */
const agentsMetadataDir = join(root, 'src/renderer/lib/agent-icons/agents')

/** Registry agent id → lobehub slug. Only agents with registered application
 * drivers belong here. Opencode is deliberately absent: its official monolith
 * mark is vendored by hand from the opencode repo and must not be overwritten
 * by reruns. */
const agentSlugs: Record<string, string> = {
  'claude-code': 'claudecode',
  cline: 'cline',
  codex: 'codex'
}

interface AgentMetadataFile {
  id: string
  name: string
  vendor: string
  website: string
  icon: string
  monochrome?: string
  primaryColor?: string
  aliases?: string[]
}

/** Bake a concrete fill color over `currentColor` so `<img>` renders it. */
function bakeFill(svg: string, color: string | undefined): string {
  if (!color) return svg
  return svg.replaceAll('fill="currentColor"', `fill="${color}"`)
}

let updatedAgents = 0

for (const [agentId, slug] of Object.entries(agentSlugs)) {
  const staticDir = join(agentsStaticDir, agentId)
  const metadataPath = join(agentsMetadataDir, agentId, 'metadata.json')
  if (!existsSync(metadataPath)) {
    Logger.dev(`[generate-brand-icons] No metadata for agent "${agentId}" — skipped.`)
    continue
  }
  const source = resolveSource(slug)
  if (!source) {
    Logger.dev(`[generate-brand-icons] No lobehub mark for agent "${agentId}" — skipped.`)
    continue
  }
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as AgentMetadataFile

  const iconSvg = bakeFill(readFileSync(source, 'utf8'), metadata.primaryColor)
  writeFileSync(join(staticDir, 'icon.svg'), `${iconSvg.trimEnd()}\n`, 'utf8')
  metadata.icon = 'icon.svg'

  const monoPath = join(sourceDir, `${slug}.svg`)
  if (existsSync(monoPath)) {
    const monoSvg = bakeFill(readFileSync(monoPath, 'utf8'), metadata.primaryColor)
    writeFileSync(join(staticDir, 'mono.svg'), `${monoSvg.trimEnd()}\n`, 'utf8')
    metadata.monochrome = 'mono.svg'
  }

  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
  updatedAgents += 1
}

Logger.dev(
  `[generate-brand-icons] Updated artwork for ${updatedAgents} agents in ${agentsStaticDir} / ${agentsMetadataDir}.`
)
