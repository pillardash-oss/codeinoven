/// <reference types="vite/client" />

/**
 * Bundled vendor brand icons for the model picker.
 *
 * SVGs live in `./icons/` and are copied from the MIT-licensed
 * `@lobehub/icons-static-svg` package by `scripts/generate-brand-icons.ts`.
 * They are inlined at build time (`?raw`) so monochrome marks that use
 * `fill="currentColor"` follow the active theme. Icons are never fetched
 * from a CDN at runtime.
 */

const iconModules = import.meta.glob('./icons/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default'
})

const iconsBySlug = new Map<string, string>()
for (const [path, svg] of Object.entries(iconModules)) {
  const slug = path.slice('./icons/'.length, -'.svg'.length)
  if (typeof svg === 'string') iconsBySlug.set(slug, svg)
}

/** Overrides for vendor names that don't normalize 1:1 to a bundled slug. */
const vendorAliases: Record<string, string> = {
  alibaba: 'qwen',
  amazon: 'aws',
  amazonbedrock: 'bedrock',
  // Anthropic and OpenAI render their harness marks (Claude Code / Codex) as
  // the canonical provider icons, so they inherit the surrounding text color.
  anthropic: 'claudecode',
  bytedance: 'doubao',
  clinepass: 'cline',
  cloudflareaigateway: 'cloudflare',
  cloudflareai: 'cloudflare',
  cloudflareworkersai: 'cloudflare',
  chatgpt: 'openai',
  codeinoven: 'cio',
  // Cursor ships its mark, its CLI and `cursor-agent acp` under one brand, so
  // the company, the CLI and the agent names all land on the same icon.
  anysphere: 'cursor',
  cursoragent: 'cursor',
  cursorcli: 'cursor',

  openai: 'codex',
  githubcopilot: 'githubcopilot',
  githubmodels: 'github',
  glm: 'zhipu',
  google: 'gemini',
  googleai: 'gemini',
  googleaistudio: 'gemini',
  googledeepmind: 'deepmind',
  googlevertex: 'gemini',
  huggingface: 'huggingface',
  llama: 'meta',
  llamacpp: 'llamacpp',
  llamacppserver: 'llamacpp',
  lmstudio: 'lmstudio',
  microsoftazure: 'azure',
  '01ai': 'zeroone',
  opencodego: 'opencode',
  opencodezen: 'opencode',
  vertexai: 'gemini',
  vercelaigateway: 'vercel'
}

export function normalizeVendorName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Canonical vendor slug for a vendor name   same normalization and aliases
 * used when resolving bundled icon SVGs. Lets callers compare two vendor
 * names (e.g. a harness vendor vs. a provider name) for identity.
 */
export function getVendorSlug(name: string | undefined): string | undefined {
  if (!name) return undefined
  // Custom base-URL providers created by CodeInOven carry a `cio-` id prefix
  // (see deriveProviderId). They are CodeInOven-vendored providers and always
  // render the CodeInOven mark, whatever their display name normalizes to.
  if (name.trim().toLowerCase().startsWith('cio-')) return 'cio'
  const key = normalizeVendorName(name)
  if (!key) return undefined
  const alias = vendorAliases[key]
  if (alias) return alias
  // Preserve canonical slugs such as openai, xai, and zai. They end in
  // "ai" but are not display-name suffixes and already have exact artwork.
  if (iconsBySlug.has(key)) return key
  // "Mistral AI" → mistral, "Together AI" → together, etc.
  return key.endsWith('ai') ? key.slice(0, -2) : key
}

/**
 * Inline SVG markup for a vendor, or `undefined` when the vendor isn't
 * bundled (callers render a monogram fallback instead).
 */
export function getVendorIconSvg(name: string | undefined): string | undefined {
  const slug = getVendorSlug(name)
  return slug ? iconsBySlug.get(slug) : undefined
}

/**
 * The mark for a model id when no provider name comes with it.
 *
 * A phone that reads a thread's `model` holds `gemini-3.5-flash`, not the
 * provider that bills it, and that id normalizes to `gemini35flash`, which is
 * nobody's slug. The bundled artwork is looked up by the longest slug the id
 * begins with, so an id still wears the mark of the company that made it; an id
 * that matches nothing returns undefined and the caller draws its own glyph.
 */
export function getModelVendorIconSvg(model: string | undefined): string | undefined {
  const direct = getVendorIconSvg(model)
  if (direct) return direct
  const key = normalizeVendorName(model ?? '')
  if (key.length < 4) return undefined
  let best: string | undefined
  for (const slug of iconsBySlug.keys()) {
    if (key.startsWith(slug) && (best === undefined || slug.length > best.length)) best = slug
  }
  return best ? iconsBySlug.get(best) : undefined
}
