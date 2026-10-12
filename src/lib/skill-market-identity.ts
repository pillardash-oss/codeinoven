/** Source-qualified identity, encoded as a flat harness-compatible folder name. */
export function marketSkillName(source: string, skillId: string): string {
  const namespace = source
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, (character) => `-x${character.charCodeAt(0).toString(16)}-`)
  const name = `${namespace}--${skillId}`
  if (name.length <= 64) return name
  // Keep the harness name within the skill specification's 64-character limit.
  let hash = 14695981039346656037n
  for (const character of name) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0)!)) * 1099511628211n)
  }
  return `${name.slice(0, 45).replace(/-+$/u, '')}-${hash.toString(16).padStart(16, '0')}`
}
