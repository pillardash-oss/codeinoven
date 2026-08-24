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
  chatgpt: 'openai',
  codeinoven: 'cio',
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
  llamacpp: 'meta',
  llamacppserver: 'meta',
  lmstudio: 'lmstudio',
  microsoftazure: 'azure',
  '01ai': 'zeroone',
  opencodego: 'opencode',
  opencodezen: 'opencode',
  vertexai: 'gemini'
}

export function normalizeVendorName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Canonical vendor slug for a vendor name — same normalization and aliases
 * used when resolving bundled icon SVGs. Lets callers compare two vendor
 * names (e.g. a harness vendor vs. a provider name) for identity.
 */
export function getVendorSlug(name: string | undefined): string | undefined {
  if (!name) return undefined
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
 * Data-URI form of a bundled vendor icon for `<img>`-based renderers
 * (e.g. rich inline badges) that can't use inline SVG markup.
 */
export function getVendorIconDataUri(name: string | undefined): string | undefined {
  const svg = getVendorIconSvg(name)
  return svg ? `data:image/svg+xml,${encodeURIComponent(svg)}` : undefined
}
