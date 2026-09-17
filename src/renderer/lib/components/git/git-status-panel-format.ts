import type { GitFileChange } from '$shared/types'

/** A folder node in the commit diff's read-only tree. */
export interface CommitTreeNode {
  name: string
  path: string
  dirs: Map<string, CommitTreeNode>
  files: GitFileChange[]
}

/** Stable background colour for a branch's avatar, keyed off its name. */
const branchAvatarPalette = [
  'bg-primary/20 text-primary',
  'bg-success/20 text-success',
  'bg-warning/20 text-warning',
  'bg-danger/20 text-danger',
  'bg-accent/20 text-accent'
]

export function branchAvatarClass(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return branchAvatarPalette[Math.abs(hash) % branchAvatarPalette.length]
}

/** Absolute commit timestamp, shown in the commit info dialog. */
export function absoluteTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(timestamp)
  )
}

export function relativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/** Cache key for one changed file's diff (staged and worktree sides differ). */
export function fileDiffKey(change: GitFileChange): string {
  return `${change.staged ? 's:' : 'w:'}${change.path}`
}

/** Groups a flat commit diff into a folder tree - read-only mirror of GitChangesTree's layout. */
export function buildCommitTree(files: GitFileChange[]): CommitTreeNode {
  const root: CommitTreeNode = { name: '', path: '', dirs: new Map(), files: [] }
  for (const change of files) {
    const segments = change.path.split('/')
    let node = root
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i] ?? ''
      let child = node.dirs.get(seg)
      if (!child) {
        child = {
          name: seg,
          path: segments.slice(0, i + 1).join('/'),
          dirs: new Map(),
          files: []
        }
        node.dirs.set(seg, child)
      }
      node = child
    }
    node.files.push(change)
  }
  return root
}

export function sortCommitDirs(dirs: Map<string, CommitTreeNode>): CommitTreeNode[] {
  return [...dirs.values()].sort((a, b) => a.name.localeCompare(b.name))
}
