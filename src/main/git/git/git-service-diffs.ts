import { lstat, open, rm, stat, unlink } from 'fs/promises'
import { isAbsolute, relative, resolve, sep } from 'path'
import type { SimpleGit } from 'simple-git'
import { toPosixPath } from '../../../lib/paths'
import type { GitDiff, GitFileChange, GitFileStatus } from '../../../lib/types'

/** Upper bound on a single diff payload so the IPC contract never floods. */
export const MAX_DIFF_BYTES = 500 * 1024

const PR_COMPOSE_UNTRACKED_BYTES = 24 * 1024
const PR_COMPOSE_UNTRACKED_FILES = 24
const PR_COMPOSE_READ_BATCH = 4

/** Whether a path exists on disk, symlinks included (broken ones still count). */
export async function pathExists(directory: string, relativePath: string): Promise<boolean> {
  try {
    await lstat(resolve(directory, relativePath))
    return true
  } catch {
    return false
  }
}

export function boundedUtf8(
  value: string,
  maximumBytes: number
): { text: string; truncated: boolean } {
  const content = Buffer.from(value, 'utf-8')
  if (content.byteLength <= maximumBytes) return { text: value, truncated: false }
  return {
    text: content.subarray(0, maximumBytes).toString('utf-8'),
    truncated: true
  }
}

/** Resolve a project-relative path and forbid escaping the repository root. */
export function assertRelativePath(directory: string, path: string): string {
  const candidate = path.trim()
  if (!candidate || candidate.includes('\0')) {
    throw new TypeError('Invalid repository path')
  }
  const absolute = isAbsolute(candidate) ? candidate : resolve(directory, candidate)
  const relativePath = relative(directory, absolute)
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new TypeError('Repository path escapes the project root')
  }
  return toPosixPath(relativePath)
}

/** Reject anything that could be interpreted as an option by `git restore`. */
export function assertTreeIsh(value: string): string {
  if (!value || value.startsWith('-')) throw new TypeError('A valid revision is required')
  return value
}

export function emptyDiff(path: string, staged: boolean): GitDiff {
  return {
    path,
    staged,
    content: '',
    binary: false,
    additions: 0,
    deletions: 0,
    truncated: false,
    before: '',
    after: ''
  }
}

export async function isUntracked(git: SimpleGit, path: string): Promise<boolean> {
  const status = await git.status()
  return status.not_added.includes(path)
}

/**
 * True when a rev (e.g. `abc123^`) resolves to an existing commit.
 *
 * Detection is read from stdout on purpose: `rev-parse --verify --quiet`
 * prints nothing and exits non-zero for a missing rev, but simple-git only
 * rejects a raw command when it produced error output   so a rejected promise
 * is not a reliable existence signal here.
 */
export async function refExists(git: SimpleGit, rev: string): Promise<boolean> {
  const resolved = await git.raw(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).then(
    (value) => value.trim(),
    () => ''
  )
  return resolved.length > 0
}

/** True when `ancestor` is reachable from `descendant` (stdout-only check). */
export async function isAncestor(
  git: SimpleGit,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  const [mergeBase, tip] = await Promise.all([
    git
      .raw(['merge-base', ancestor, descendant])
      .then((value) => value.trim())
      .catch(() => ''),
    git
      .raw(['rev-parse', ancestor])
      .then((value) => value.trim())
      .catch(() => '')
  ])
  // `git merge-base --is-ancestor` signals through its exit code, which is not
  // surfaced reliably here   comparing the merge base with the ancestor's own
  // tip gives the same answer from stdout alone.
  return mergeBase.length > 0 && mergeBase === tip
}

/** True when the path resolves to a directory inside the repository. */
export async function isDirectory(directory: string, path: string): Promise<boolean> {
  try {
    const info = await stat(resolve(directory, path))
    return info.isDirectory()
  } catch {
    return false
  }
}

/** Recursively remove a file or directory that is not tracked by git. */
export async function removePath(absolute: string): Promise<void> {
  try {
    const info = await stat(absolute)
    if (info.isDirectory()) {
      await rm(absolute, { recursive: true, force: true })
    } else {
      await unlink(absolute)
    }
  } catch {
    // Nothing to remove   treat as already gone.
  }
}

/**
 * Read a git blob (e.g. `HEAD:src/a.ts` or `:src/a.ts`) with a payload cap.
 * Returns null when the path does not exist in that ref (new/deleted files).
 * Blobs larger than 8x the diff bound are skipped rather than buffered whole.
 */
export async function readBlob(
  git: SimpleGit,
  ref: string
): Promise<{ content: string; truncated: boolean } | null> {
  let size: number | null
  try {
    const sizeOutput = await git.raw(['cat-file', '-s', ref])
    size = Number.parseInt(String(sizeOutput).trim(), 10)
  } catch {
    return null
  }
  if (size === null || !Number.isFinite(size) || size < 0) return null
  if (size === 0) return { content: '', truncated: false }
  if (size > MAX_DIFF_BYTES * 8) return { content: '', truncated: true }
  let output: unknown
  try {
    output = await git.raw(['cat-file', 'blob', ref])
  } catch {
    return null
  }
  const text = String(output ?? '')
  const truncated = size > MAX_DIFF_BYTES
  return { content: truncated ? text.slice(0, MAX_DIFF_BYTES) : text, truncated }
}

/**
 * Read a working-tree file bounded to the diff payload cap, detecting binary
 * content via NUL bytes (mirrors the old untracked-diff probe).
 */
export async function workingFileContent(
  directory: string,
  path: string
): Promise<{ content: string; truncated: boolean; binary: boolean } | null> {
  const filePath = resolve(directory, path)
  const metadata = await stat(filePath).catch(() => null)
  if (!metadata) return null

  const readHead = async (): Promise<string | null> => {
    const size = Math.min(metadata.size, MAX_DIFF_BYTES + 1)
    const buffer = Buffer.alloc(size)
    try {
      const handle = await open(filePath, 'r')
      try {
        await handle.read(buffer, 0, size, 0)
      } finally {
        await handle.close()
      }
    } catch {
      return null
    }
    return buffer.toString('utf-8')
  }

  const head = await readHead()
  if (head === null) return null
  const truncated = metadata.size > MAX_DIFF_BYTES
  return {
    content: truncated ? head.slice(0, MAX_DIFF_BYTES) : head,
    truncated,
    binary: head.includes('\0')
  }
}

/** Build a bounded `+` diff for an untracked file, detecting binary content. */
export async function untrackedDiff(directory: string, path: string): Promise<GitDiff> {
  const file = await workingFileContent(directory, path)
  if (!file) return emptyDiff(path, false)
  if (file.binary) return { ...emptyDiff(path, false), binary: true }
  const additions = file.content.split('\n').length
  return {
    path,
    staged: false,
    content: file.content
      .split('\n')
      .map((line) => `+${line}`)
      .join('\n'),
    before: '',
    after: file.content,
    binary: false,
    additions,
    deletions: 0,
    truncated: file.truncated
  }
}

/** Read small previews of untracked text files without adding them to Git. */
export async function untrackedComposeContext(
  directory: string,
  git: SimpleGit
): Promise<{ text: string; truncated: boolean }> {
  const status = await git.status()
  const candidates = status.not_added.slice(0, PR_COMPOSE_UNTRACKED_FILES)
  let remainingBytes = PR_COMPOSE_UNTRACKED_BYTES
  let truncated = status.not_added.length > candidates.length
  const sections: string[] = []

  for (
    let index = 0;
    index < candidates.length && remainingBytes > 0;
    index += PR_COMPOSE_READ_BATCH
  ) {
    const batch = candidates.slice(index, index + PR_COMPOSE_READ_BATCH)
    const previews = await Promise.all(
      batch.map(async (relativePath) => {
        const safePath = assertRelativePath(directory, relativePath)
        const absolutePath = resolve(directory, safePath)
        const metadata = await lstat(absolutePath).catch(() => null)
        if (!metadata?.isFile() || metadata.isSymbolicLink())
          return { path: safePath, text: '', binary: true, truncated: false }
        const maximum = Math.min(8 * 1024, remainingBytes)
        const handle = await open(absolutePath, 'r')
        try {
          const buffer = Buffer.allocUnsafe(maximum)
          const { bytesRead } = await handle.read(buffer, 0, maximum, 0)
          const content = buffer.subarray(0, bytesRead)
          const binary = content.includes(0)
          return {
            path: safePath,
            text: binary ? '' : content.toString('utf-8'),
            binary,
            truncated: metadata.size > bytesRead
          }
        } finally {
          await handle.close()
        }
      })
    )
    for (const preview of previews) {
      const body = preview.binary ? '[binary or unreadable file]' : preview.text
      const section = `File ${JSON.stringify(preview.path)}\n${body}`
      const bounded = boundedUtf8(section, remainingBytes)
      sections.push(bounded.text)
      remainingBytes -= Buffer.byteLength(bounded.text, 'utf-8')
      truncated ||= preview.truncated || bounded.truncated
      if (bounded.truncated) break
    }
  }
  return { text: sections.join('\n\n'), truncated }
}

/** Files changed by any commit-like ref (hash or `stash@{n}`), vs its first parent. */
export async function diffVsParent(git: SimpleGit, ref: string): Promise<GitFileChange[]> {
  const safeRef = ref.trim()
  const result = await git.show([`${safeRef}^!`, '--stat', '--format='])
  const lines = result.split('\n').filter((line) => line.trim())
  const changes: GitFileChange[] = []
  for (const line of lines) {
    const match = /^(.+?)\s+\|\s+(\d+)\s+([+-]+)/u.exec(line)
    if (match) {
      const path = match[1]?.trim() ?? ''
      const statusChar = match[3]?.[0] ?? 'M'
      const status: GitFileStatus =
        statusChar === '+' ? 'added' : statusChar === '-' ? 'deleted' : 'modified'
      changes.push({ path, status, staged: false })
    }
  }
  return changes
}

/** Per-file diff for any commit-like ref (hash or `stash@{n}`), vs its first parent. */
export async function fileDiffVsParent(
  git: SimpleGit,
  directory: string,
  ref: string,
  relativePath: string
): Promise<GitDiff> {
  const safeRef = ref.trim()
  const safePath = assertRelativePath(directory, relativePath)
  const parentRef = `${safeRef}^`
  const parentExists = await refExists(git, parentRef)
  if (!parentExists) {
    // Root commit: the whole file is new, reuse the untracked/added shape.
    const blob = await readBlob(git, `${safeRef}:${safePath}`)
    if (!blob) return emptyDiff(safePath, false)
    const additions = blob.content.length === 0 ? 0 : blob.content.split('\n').length
    return {
      path: safePath,
      staged: false,
      content: blob.content
        .split('\n')
        .map((line) => `+${line}`)
        .join('\n'),
      before: '',
      after: blob.content,
      binary: blob.content.includes('\0'),
      additions,
      deletions: 0,
      truncated: blob.truncated
    }
  }
  const content = await git.diff([parentRef, safeRef, '--', safePath])
  const summary = await git.diffSummary([parentRef, safeRef, '--', safePath])
  const file = summary.files[0]
  const additions =
    file && 'insertions' in file && typeof file.insertions === 'number' ? file.insertions : 0
  const deletions =
    file && 'deletions' in file && typeof file.deletions === 'number' ? file.deletions : 0
  const binary = file?.binary ?? false
  const truncated = Buffer.byteLength(content, 'utf-8') > MAX_DIFF_BYTES
  const boundedContent = truncated
    ? `${content.slice(0, MAX_DIFF_BYTES)}\n… (diff truncated to ${MAX_DIFF_BYTES} bytes)`
    : content

  let before: string | undefined
  let after: string | undefined
  let sideTruncated = false
  if (!binary) {
    const beforeBlob = await readBlob(git, `${parentRef}:${safePath}`)
    const afterBlob = await readBlob(git, `${safeRef}:${safePath}`)
    before = beforeBlob?.content
    after = afterBlob?.content
    sideTruncated = (beforeBlob?.truncated ?? false) || (afterBlob?.truncated ?? false)
  }

  return {
    path: safePath,
    staged: false,
    content: boundedContent,
    binary,
    additions,
    deletions,
    truncated: truncated || sideTruncated,
    before,
    after
  }
}
