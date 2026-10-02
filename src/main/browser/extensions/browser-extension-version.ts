/** Compare Chrome extension versions, whose components are dot-separated integers. */
export function compareBrowserExtensionVersions(left: string, right: string): number | null {
  const parse = (value: string): bigint[] | null => {
    if (!/^\d+(?:\.\d+){0,3}$/u.test(value)) return null
    return value.split('.').map((part) => BigInt(part))
  }

  const leftParts = parse(left)
  const rightParts = parse(right)
  if (!leftParts || !rightParts) return null

  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0n
    const rightPart = rightParts[index] ?? 0n
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1
  }
  return 0
}
