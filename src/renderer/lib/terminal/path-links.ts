import type { ILink, ILinkProvider } from 'ghostty-web'
import { invoke } from '$lib/ipc.svelte'

/**
 * A buffer line as exposed by ghostty-web's active buffer. Only the cell
 * accessor is relied on — same contract the library's own link providers use.
 */
export interface TerminalLine {
  length: number
  getCell(x: number): { getCode(): number } | undefined
}

interface FileLinkProviderOptions {
  /** Resolve the id of the project that owns this terminal session. */
  getProjectId: () => string | null
}

interface CellRange {
  start: { x: number; y: number }
  end: { x: number; y: number }
}

interface ScannedCandidate {
  /** The variant string that passed validation (resolves to a real entry). */
  resolved: string
  range: CellRange
  text: string
}

interface ValidationEntry {
  path: string | null
  at: number
}

/**
 * Matches path-like tokens on a single buffer line. A candidate must contain at
 * least one directory slash (so bare filenames and fractions like `1/2` are
 * skipped) and may carry a trailing `:line` or `:line:col` suffix plus git
 * `a/`/`b/` diff prefixes. Anything a regex can match that does not resolve to
 * a real project entry is filtered out by on-disk validation.
 */
const PATH_CANDIDATE =
  /(?<![A-Za-z0-9_.-])((?:\.\.?\/|~\/|\/)?(?:[\w@.-]+\/)+[\w@.+-]{2,}\/?)(?::(\d+)(?::(\d+))?)?(?![A-Za-z0-9_.@/])/g

/** Convert a buffer line to plain text with columns aligned 1:1 to cells. */
function lineToText(line: TerminalLine): string {
  const chars: string[] = []
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x)
    if (!cell) {
      chars.push(' ')
      continue
    }
    const codepoint = cell.getCode()
    if (codepoint === 0 || codepoint < 32) {
      chars.push(' ')
    } else {
      chars.push(String.fromCodePoint(codepoint))
    }
  }
  return chars.join('')
}

/** A candidate whose match sits inside a `scheme://` URL is left to the URL provider. */
function isInsideUrlScheme(line: string, index: number): boolean {
  return line[index - 1] === '/' && line[index - 2] === ':'
}

/** Normalize a matched token into the variants worth validating on disk. */
function candidateVariants(matched: string, line: string, index: number): string[] {
  let clean = matched
  const colon = clean.match(/:(\d+)(?::(\d+))?$/u)
  if (colon) clean = clean.slice(0, -colon[0].length)
  clean = clean.replace(/\/+$/u, '')
  if (clean.length === 0 || isInsideUrlScheme(line, index)) return []

  const variants = [clean]
  if (/^[ab]\//u.test(clean) && clean.length > 2) {
    variants.push(clean.slice(2))
  }
  return variants
}

/**
 * Provides disk-validated file/directory links for a ghostty-web terminal.
 *
 * ghostty-web only ships OSC 8 and URL providers; file paths are deliberately
 * excluded by its URL regex. This provider reuses the app's citation-path
 * machinery (`projectFiles:resolveCitationPaths`) so that only paths that
 * actually exist inside the owning project are underlined, and cmd/ctrl+click
 * reveals them in the OS file manager (`shell:revealPath`).
 */
export class FileLinkProvider implements ILinkProvider {
  private readonly validated = new Map<string, ValidationEntry>()

  constructor(
    private readonly terminal: {
      buffer: { active: { getLine(y: number): TerminalLine | undefined } }
    },
    private readonly options: FileLinkProviderOptions
  ) {}

  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const line = this.terminal.buffer.active.getLine(y)
    if (!line) {
      callback(undefined)
      return
    }
    const projectId = this.options.getProjectId()
    if (!projectId) {
      callback(undefined)
      return
    }

    const text = lineToText(line)
    const scanned = this.scanLine(text, y)
    if (scanned.length === 0) {
      callback(undefined)
      return
    }

    this.resolve(projectId, scanned)
      .then(() => {
        const links: ILink[] = []
        for (const candidate of scanned) {
          if (!candidate.resolved) continue
          links.push(this.makeLink(candidate, projectId))
        }
        callback(links.length > 0 ? links : undefined)
      })
      .catch(() => callback(undefined))
  }

  private scanLine(
    text: string,
    y: number
  ): Array<ScannedCandidate & { pendingVariants: string[] }> {
    const scanned: Array<ScannedCandidate & { pendingVariants: string[] }> = []
    PATH_CANDIDATE.lastIndex = 0
    let match = PATH_CANDIDATE.exec(text)
    while (match !== null) {
      const matched = match[1] ?? ''
      const variants = candidateVariants(matched, text, match.index)
      if (variants.length > 0) {
        const startX = match.index
        const endX = match.index + match[0].length - 1
        scanned.push({
          resolved: '',
          pendingVariants: variants,
          range: { start: { x: startX, y }, end: { x: endX, y } },
          text: matched
        })
      }
      match = PATH_CANDIDATE.exec(text)
    }
    return scanned
  }

  private async resolve(
    projectId: string,
    scanned: Array<ScannedCandidate & { pendingVariants: string[] }>
  ): Promise<void> {
    const needsCheck = new Set<string>()
    for (const candidate of scanned) {
      for (const variant of candidate.pendingVariants) {
        if (!this.lookupValidated(variant)) needsCheck.add(variant)
      }
    }

    if (needsCheck.size > 0) {
      try {
        const result = await invoke('projectFiles:resolveCitationPaths', projectId, [...needsCheck])
        const now = Date.now()
        for (const [variant, path] of Object.entries(result)) {
          this.validated.set(variant, { path, at: now })
        }
      } catch {
        // Unresolvable candidates simply never become links.
      }
    }
    this.prune()

    for (const candidate of scanned) {
      for (const variant of candidate.pendingVariants) {
        const entry = this.lookupValidated(variant)
        if (entry?.path) {
          candidate.resolved = entry.path
          break
        }
      }
    }
  }

  private lookupValidated(variant: string): ValidationEntry | undefined {
    const entry = this.validated.get(variant)
    if (!entry) return undefined
    if (Date.now() - entry.at > VALIDATION_TTL_MS) {
      this.validated.delete(variant)
      return undefined
    }
    return entry
  }

  private prune(): void {
    if (this.validated.size <= VALIDATION_CACHE_LIMIT) return
    const now = Date.now()
    for (const [variant, entry] of this.validated) {
      if (now - entry.at > VALIDATION_TTL_MS) this.validated.delete(variant)
    }
    if (this.validated.size > VALIDATION_CACHE_LIMIT) this.validated.clear()
  }

  private makeLink(candidate: ScannedCandidate, projectId: string): ILink {
    return {
      text: candidate.text,
      range: candidate.range,
      activate: (event: MouseEvent) => {
        if (!(event.ctrlKey || event.metaKey)) return
        void revealPath(projectId, candidate.resolved)
      }
    }
  }
}

/** Freshness window for validated candidates; keeps IPC churn low on live output. */
const VALIDATION_TTL_MS = 10_000
/** Upper bound on cached validation results before the whole cache is dropped. */
const VALIDATION_CACHE_LIMIT = 300

async function revealPath(projectId: string, relativePath: string): Promise<void> {
  try {
    const info = await invoke('projectFiles:info', projectId, relativePath)
    await invoke('shell:revealPath', info.absolutePath)
  } catch {
    // The entry may have been deleted between scan and click — nothing to reveal.
  }
}
