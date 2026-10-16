import { parentPort, workerData } from 'node:worker_threads'
/** Match real opening tags, excluding comments, raw script/style text and quoted > characters. */
function requireSourceTarget(html: string, id: string): { start: number; end: number } | null {
  const tags = html.matchAll(
    /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<[a-zA-Z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/giu
  )
  let count = 0
  const styles: { start: number; end: number }[] = []
  for (const match of tags) {
    if (
      match[1]?.toLowerCase() === 'style' &&
      match[0].startsWith(`<style data-cio-motion="${id}">`)
    )
      styles.push({ start: match.index!, end: match.index! + match[0].length })
    if (match[0].startsWith('<!--') || match[1]) continue
    const attributes = match[0].matchAll(
      /\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu
    )
    for (const attribute of attributes) {
      if (
        attribute[1].toLowerCase() === 'id' &&
        (attribute[2] ?? attribute[3] ?? attribute[4]) === id
      )
        count += 1
    }
  }
  if (count !== 1)
    throw new Error(
      'targetId must identify exactly one element in the HTML source. Give the selected element a unique stable id first.'
    )
  if (styles.length > 1) throw new Error('Duplicate motion blocks must be resolved before editing')
  return styles[0] ?? null
}

try {
  const { source, id } = workerData as { source: string; id: string }
  const styleRange = requireSourceTarget(source, id)
  parentPort?.postMessage({ ok: true, styleRange })
} catch (error: unknown) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) })
}
