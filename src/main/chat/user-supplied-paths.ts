import { homedir } from 'os'
import { isAbsolute, resolve } from 'path'
import { fileURLToPath } from 'url'
import type { AgentPart } from '../../lib/types'

/** Only user-authored message parts may be passed here. Never infer grants from tool output. */
export function userSuppliedPaths(parts: readonly AgentPart[], projectPath: string): string[] {
  const paths = new Set<string>()
  const add = (value: string, attachment = false): void => {
    try {
      const path = value.startsWith('file:')
        ? fileURLToPath(value)
        : value.startsWith('~/')
          ? resolve(homedir(), value.slice(2))
          : value
      if (isAbsolute(path) || path.startsWith('../') || path.startsWith('./') || attachment)
        paths.add(resolve(projectPath, path))
    } catch {
      // Malformed local URLs are not authorization to another path.
    }
  }
  for (const part of parts) {
    if (part.type === 'file' && part.url) {
      if (
        isAbsolute(part.url) ||
        !/^[a-z][a-z\d+.-]*:/iu.test(part.url) ||
        part.url.startsWith('file:')
      ) {
        add(part.url, true)
      }
    }
    if (part.type !== 'text') continue
    // Quoted paths support spaces; Markdown destinations and bare paths cover
    // pasted local links. Consume web URLs whole so their slash is never a grant.
    const pattern =
      /`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'|\]\(([^)\n]+)\)|https?:\/\/[^\s<>]+|(?:^|[\s<(])((?:file:\/\/|~\/|\.\.?\/|[A-Za-z]:[\\/]|\/)[^\s<>`"')]+)/gmu
    for (const match of part.text.matchAll(pattern)) {
      const candidate =
        match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]?.replace(/[.,;:!?]+$/u, '')
      if (candidate) add(candidate)
    }
  }
  return [...paths]
}
