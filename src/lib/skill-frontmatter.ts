/**
 * The frontmatter of a SKILL.md, read and written for an install copy.
 *
 * A skill's folder is its identity: a harness resolves a skill by the folder
 * that holds its SKILL.md and reads the `name` declared beside it. The two are
 * expected to agree, so the copy this app installs into a project or a thread
 * carries a `name` equal to the folder holding it, whatever the source document
 * declared. Every other field and the body are kept exactly as written, and a
 * document that carries no frontmatter at all gains one, because a skill without
 * a name and a description is not a skill any harness can load.
 *
 * The shapes live here because the main-process installer writes these copies and
 * the renderer reads the same fields to name a draft, and both sides have to
 * agree on what a skill file says about itself.
 */

/** Opening fence, frontmatter, closing fence, and the line break after it. */
const FRONTMATTER_PATTERN = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u

/** Wording used when a skill arrives with nothing to say about itself. */
const FALLBACK_DESCRIPTION = 'Describe when an agent should use this skill.'

/** One top-level frontmatter line and the key it declares. */
function frontmatterField(line: string): { key: string; value: string } | null {
  if (/^\s/u.test(line)) return null
  const separator = line.indexOf(':')
  if (separator <= 0) return null
  return {
    key: line.slice(0, separator).trim().toLowerCase(),
    value: line.slice(separator + 1).trim()
  }
}

/** Strip the quoting a writer may have applied, without interpreting YAML. */
function unquoted(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? trimmed.slice(1, -1).trim()
    : trimmed
}

/** A one-line YAML scalar, quoted when a plain one would read as something else. */
function yamlScalar(value: string): string {
  const single = value.replace(/\s+/gu, ' ').trim()
  return /^[A-Za-z0-9][A-Za-z0-9 ,._/()-]*$/u.test(single) ? single : JSON.stringify(single)
}

/**
 * The name a SKILL.md declares in its frontmatter, or null when it declares
 * none. A block scalar (`name: |`) names nothing usable, so it counts as none.
 */
export function skillFrontmatterName(markdown: string): string | null {
  const match = markdown.match(FRONTMATTER_PATTERN)
  if (!match?.[1]) return null
  for (const line of match[1].split(/\r?\n/u)) {
    const field = frontmatterField(line)
    if (field?.key !== 'name') continue
    const value = unquoted(field.value)
    return value && !/^[|>]/u.test(value) ? value : null
  }
  return null
}

/**
 * The install copy of one skill document. Its frontmatter names the folder that
 * holds it and describes the skill; every other field and the whole body are
 * left as the author wrote them.
 */
export function skillInstallDocument(input: {
  /** The document as the registry holds it. */
  markdown: string
  /** The folder this copy is installed into, which is the skill's name. */
  name: string
  /** The registry entry's description, used only when the file declares none. */
  description?: string
  /** Wording used when neither the file nor the entry describes the skill. */
  fallbackDescription?: string
}): string {
  const body = input.markdown.trimEnd()
  const description = (input.description ?? '').trim()
  const match = body.match(FRONTMATTER_PATTERN)
  if (!match) {
    return [
      '---',
      `name: ${yamlScalar(input.name)}`,
      `description: ${yamlScalar(description || input.fallbackDescription || FALLBACK_DESCRIPTION)}`,
      '---',
      '',
      body
    ].join('\n')
  }

  let named = false
  let described = false
  const fields = match[1].split(/\r?\n/u).map((line) => {
    const field = frontmatterField(line)
    if (field?.key === 'name') {
      named = true
      return unquoted(field.value) === input.name ? line : `name: ${yamlScalar(input.name)}`
    }
    if (field?.key === 'description') {
      described = true
      // A block scalar owns the lines beneath it, so it is left untouched.
      if (/^[|>]/u.test(field.value)) return line
      const value = unquoted(field.value)
      if (value) return line
      return `description: ${yamlScalar(description || input.fallbackDescription || FALLBACK_DESCRIPTION)}`
    }
    return line
  })

  if (!named) fields.unshift(`name: ${yamlScalar(input.name)}`)
  if (!described) {
    fields.push(
      `description: ${yamlScalar(description || input.fallbackDescription || FALLBACK_DESCRIPTION)}`
    )
  }
  return `---\n${fields.join('\n')}\n---\n${body.slice(match[0].length)}`
}
