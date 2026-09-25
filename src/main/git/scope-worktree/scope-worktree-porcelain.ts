interface ParsedPorcelainEntry {
  path: string
  head?: string
  bare: boolean
  detached: boolean
  locked: boolean
  prunable: boolean
}

export interface ParsedWorktreeList {
  entries: ParsedPorcelainEntry[]
}

/**
 * Parse `git worktree list --porcelain -z`. With `-z` every field is
 * NUL-terminated and records are separated by an extra NUL, so we split on NUL
 * and group tokens, closing each record at every empty separator.
 *
 * Field forms:
 *   `worktree <path>`      absolute path
 *   `HEAD <sha>`           commit hash (or `detached`)
 *   `branch <ref>`         e.g. `refs/heads/cio/feature` (absent when detached)
 *   `bare` / `detached` / `prunable`
 *   `locked`               optionally followed by a NUL-terminated reason
 */
export function parseWorktreePorcelain(output: string): ParsedWorktreeList {
  const entries: ParsedPorcelainEntry[] = []
  let current: ParsedPorcelainEntry | null = null

  const flush = (): void => {
    if (current) entries.push(current)
    current = null
  }

  for (const token of output.split('\0')) {
    if (!token) {
      flush()
      continue
    }
    if (!current)
      current = { path: '', bare: false, detached: false, locked: false, prunable: false }
    if (token === 'bare') {
      current.bare = true
      continue
    }
    if (token === 'detached') {
      current.detached = true
      continue
    }
    if (token === 'prunable') {
      current.prunable = true
      continue
    }
    if (token.startsWith('locked')) {
      current.locked = true
      continue
    }
    if (token.startsWith('worktree ')) {
      current.path = token.slice('worktree '.length)
      continue
    }
    if (token.startsWith('branch ')) {
      // Resolution needs the checked-out branch, not the HEAD commit.
      current.head = token.slice('branch '.length)
      continue
    }
    // `HEAD <sha>` and `reason <text>` tokens carry no branch identity.
  }
  flush()
  return { entries }
}
