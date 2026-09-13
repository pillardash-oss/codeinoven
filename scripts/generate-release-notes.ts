/**
 * generate-release-notes — build user-facing release notes from the commit log
 * between two refs, grouped by change type, for the GitHub release pages.
 *
 * Used by `.github/workflows/nightly.yml` (nightly prereleases) and
 * `.github/workflows/release.yml` (stable releases) so every published release
 * carries a readable changelog instead of a placeholder sentence. The in-app
 * updater (electron-updater GitHub provider) surfaces the release body as
 * `UpdateInfo.releaseNotes`, so these notes also flow into the app.
 *
 * Commit subjects follow the repo convention `<author> (<type>): <title>`
 * (plus plain conventional `type(scope): title`). The author prefix is an
 * internal agent/model name and is stripped: users care about the change, not
 * which model wrote it. Merge commits are excluded (`--no-merges`) and
 * version-bump chores are dropped as noise.
 *
 * Usage:
 *   bun scripts/generate-release-notes.ts --channel nightly --to HEAD --out release-notes.md
 *   bun scripts/generate-release-notes.ts --from v0.5.52 --to HEAD --channel stable --out release-notes.md
 *
 * Flags:
 *   --channel nightly|stable  How to auto-resolve `--from` when omitted:
 *                             nightly -> the newest published nightly tag of
 *                             the current base version, else the last stable
 *                             release tag; stable -> the last stable release
 *                             tag. Resolution uses `gh release list` (falls
 *                             back to local `git tag`).
 *   --from <ref>              Range start (defaults to the resolution above).
 *   --to <ref>                Range end (default HEAD).
 *   --out <path>              Write markdown to a file instead of stdout.
 *   --repo <owner/name>       Repo slug for the compare link (default from
 *                             electron-builder.yml publish config).
 *
 * Exit codes: 0 on success (including the "no commits" case, which emits a
 * fallback note), 1 on bad flags or unresolvable repo state.
 */

import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const REPO = 'pillardash-oss/codeinoven'

interface CliFlags {
  channel: 'nightly' | 'stable' | undefined
  from: string | undefined
  to: string
  out: string | undefined
  repo: string
}

/** Change types recognized in commit subjects, mapped to user-facing headings. */
const TYPE_HEADINGS: Record<string, string> = {
  feat: 'Added',
  fix: 'Fixed',
  perf: 'Performance',
  refactor: 'Changed',
  style: 'Changed',
  docs: 'Documentation',
  chore: 'Maintenance',
  build: 'Maintenance',
  ci: 'Maintenance',
  test: 'Maintenance'
}

/** Ordered headings in the rendered notes. */
const HEADING_ORDER = [
  'Added',
  'Fixed',
  'Performance',
  'Changed',
  'Documentation',
  'Dependencies',
  'Maintenance',
  'Other'
] as const

/** A subject split into its user-facing heading and cleaned title. */
interface ParsedSubject {
  heading: string
  title: string
}

/** Subjects that are release plumbing, never worth a user-facing bullet. */
const NOISE_PATTERNS: RegExp[] = [
  /^chore(?:\([^)]*\))?:\s*bump version\b/i,
  /^chore(?:\([^)]*\))?:\s*release\b/i,
  /^chore(?:\([^)]*\))?:\s*merge branch/i
]

/**
 * Parse one commit subject.
 *
 * Recognized shapes:
 *   `<author> (<type>): <title>`   repo convention, e.g. "GLM (fix): start GDI+ ..."
 *   `<type>(<scope>): <title>`     conventional commits, e.g. "feat(export): ..."
 *   `<type>: <title>`              bare conventional, e.g. "fix: windows startup"
 *   anything else                  "Other" heading with the raw subject
 */
export function parseSubject(subject: string): ParsedSubject {
  const trimmed = subject.trim()

  // Repo convention: "glm-5.3-flash (fix): title" — author may contain dots/dashes.
  const authored = /^(.+?)\s+\(([a-zA-Z][a-zA-Z-]*)\):\s*(.+)$/.exec(trimmed)
  if (authored) {
    const [, , rawType, rawTitle] = authored
    const title = rawTitle.trim()
    return { heading: headingForType(rawType, title), title }
  }

  // Conventional commit with optional scope: "fix(ipc): title".
  const conventional = /^([a-zA-Z][a-zA-Z-]*)(?:[(]([^)]+)[)])?:\s*(.+)$/.exec(trimmed)
  if (conventional) {
    const [, rawType, scope, rawTitle] = conventional
    const title = rawTitle.trim()
    if (scope === 'deps') {
      return { heading: 'Dependencies', title }
    }
    return { heading: headingForType(rawType, title), title }
  }

  return { heading: 'Other', title: trimmed }
}

/** Map a raw commit type to its heading; unknown types fall back to "Other". */
function headingForType(rawType: string, title: string): string {
  if (rawType === 'chore' && /^bump\b.*\b(?:v?\d+\.\d+\.\d+|package\.json|dependencies)/i.test(title)) {
    return 'Dependencies'
  }
  return TYPE_HEADINGS[rawType.toLowerCase()] ?? 'Other'
}

/** Split a commit list into heading -> unique, capitalized bullet titles. */
export function groupSubjects(subjects: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  const seen = new Set<string>()
  for (const subject of subjects) {
    if (NOISE_PATTERNS.some((pattern) => pattern.test(subject))) continue
    const parsed = parseSubject(subject)
    const key = `${parsed.heading}\u0000${parsed.title.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    const list = groups.get(parsed.heading) ?? []
    list.push(parsed.title)
    groups.set(parsed.heading, list)
  }
  return groups
}

/** Run a git command safely (no shell interpolation) and return trimmed stdout. */
function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim()
}

/** List release tags via `gh`, preferring it over possibly-stale local tags. */
function ghReleaseTags(): { prerelease: string[]; stable: string[] } | null {
  try {
    const stdout = execFileSync(
      'gh',
      ['release', 'list', '--limit', '1000', '--json', 'tagName,isPrerelease'],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
    )
    interface GhReleaseRow {
      tagName: string
      isPrerelease: boolean
    }
    const rows = JSON.parse(stdout) as GhReleaseRow[]
    const prerelease: string[] = []
    const stable: string[] = []
    for (const row of rows) {
      if (!row.tagName) continue
      if (row.isPrerelease) prerelease.push(row.tagName)
      else stable.push(row.tagName)
    }
    return { prerelease, stable }
  } catch {
    return null
  }
}

/** Semantically compare two `X.Y.Z` versions. Returns >0, 0 or <0. */
function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Resolve the range start for a channel without an explicit `--from`.
 * For nightly builds of base `X.Y.Z`: newest `vX.Y.Z-nightly.[N]` tag, else the
 * last stable `vX.Y.Z` tag. For stable builds: the last stable tag.
 * Falls back to the oldest commit when nothing resolves (first-ever release).
 */
export function resolveFromRef(channel: 'nightly' | 'stable', baseVersion: string): string {
  const releases = ghReleaseTags()
  const tags = releases ?? { prerelease: [], stable: [] }
  const stableTags = tags.stable
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .sort((a, b) => compareVersions(b.slice(1), a.slice(1)))

  if (channel === 'nightly') {
    const nightlyTags = tags.prerelease
      .filter((t) => new RegExp(`^v${baseVersion.replace(/\./g, '\\.')}-nightly[.-]\\d+$`).test(t))
      .sort((a, b) => {
        const na = Number(/\d+$/.exec(a)?.[0] ?? 0)
        const nb = Number(/\d+$/.exec(b)?.[0] ?? 0)
        return nb - na
      })
    if (nightlyTags.length > 0) return nightlyTags[0]
    if (stableTags.length > 0) return stableTags[0]
  } else if (stableTags.length > 0) {
    return stableTags[0]
  }

  // gh unavailable or no releases: fall back to local tags so a local run and
  // a CI run without gh still produce correct notes.
  const localNightly = channel === 'nightly'
    ? git('tag', '--list', `v${baseVersion}-nightly*`).split('\n').filter(Boolean)
    : []
  if (localNightly.length > 0) {
    return localNightly.sort((a, b) => {
      const na = Number(/\d+$/.exec(a)?.[0] ?? 0)
      const nb = Number(/\d+$/.exec(b)?.[0] ?? 0)
      return nb - na
    })[0]
  }
  const localStable = git('tag', '--list', 'v*.*.*')
    .split('\n')
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .sort((a, b) => compareVersions(b.slice(1), a.slice(1)))
  if (localStable.length > 0) return localStable[0]

  return git('rev-list', '--max-parents=0', 'HEAD').split('\n').pop() ?? 'HEAD'
}

/** Render the grouped commits as the markdown release body. */
export function renderNotes(input: {
  channel: 'nightly' | 'stable'
  repo: string
  from: string
  to: string
  subjects: string[]
  baseVersion: string
}): string {
  if (input.subjects.length === 0) {
    return [
      input.channel === 'nightly'
        ? `Nightly build of version ${input.baseVersion} from the \`nightly\` branch.`
        : `Stable release of version ${input.baseVersion}.`,
      '',
      'No code changes since the previous release of this channel; this build reflects the same content with refreshed metadata.',
      ''
    ].join('\n')
  }

  const groups = groupSubjects(input.subjects)
  const lines: string[] = [
    input.channel === 'nightly'
      ? `## What's changed in version ${input.baseVersion}`
      : `## What's changed in version ${input.baseVersion}`,
    ''
  ]
  for (const heading of HEADING_ORDER) {
    const titles = groups.get(heading)
    if (!titles || titles.length === 0) continue
    lines.push(`### ${heading}`, '')
    for (const title of titles) {
      lines.push(`- ${title}`)
    }
    lines.push('')
  }
  lines.push(
    `**Full changelog**: https://github.com/${input.repo}/compare/${input.from}...${input.to}`,
    ''
  )
  return lines.join('\n')
}

function parseFlags(argv: readonly string[]): CliFlags {
  const flags: CliFlags = {
    channel: undefined,
    from: undefined,
    to: 'HEAD',
    out: undefined,
    repo: REPO
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = argv[i + 1]
    if (arg === '--channel') {
      if (value !== 'nightly' && value !== 'stable') {
        throw new Error('--channel must be "nightly" or "stable"')
      }
      flags.channel = value
      i += 1
    } else if (arg === '--from' && value !== undefined) {
      flags.from = value
      i += 1
    } else if (arg === '--to' && value !== undefined) {
      flags.to = value
      i += 1
    } else if (arg === '--out' && value !== undefined) {
      flags.out = value
      i += 1
    } else if (arg === '--repo' && value !== undefined) {
      flags.repo = value
      i += 1
    } else {
      throw new Error(`Unknown flag: ${arg}`)
    }
  }
  if (!flags.channel) throw new Error('--channel nightly|stable is required')
  return flags
}

async function main(): Promise<number> {
  let flags: CliFlags
  try {
    flags = parseFlags(process.argv.slice(2))
  } catch (error: unknown) {
    // eslint-disable-next-line no-console
    console.error(String(error instanceof Error ? error.message : error))
    return 1
  }

  // parseFlags already enforces --channel; this narrows the type for TS.
  const channel = flags.channel
  if (channel === undefined) {
    // eslint-disable-next-line no-console
    console.error('--channel nightly|stable is required')
    return 1
  }

  let from = flags.from
  if (!from) {
    let baseVersion: string
    try {
      const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
        version?: unknown
      }
      if (typeof pkg.version !== 'string') throw new TypeError('package.json version is not a string')
      baseVersion = pkg.version
    } catch (error: unknown) {
      // eslint-disable-next-line no-console
      console.error(`Could not read package.json version: ${String(error)}`)
      return 1
    }
    from = resolveFromRef(channel, baseVersion)
  }

  // Fail early with a clear message if the range is invalid (unknown ref).
  // Local checkouts can lag behind published tags, so one tag fetch is tried
  // before giving up (CI checkouts with fetch-depth: 0 already have all tags).
  const verifyFrom = (): void => {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${from}^{commit}`])
  }
  try {
    verifyFrom()
  } catch {
    try {
      execFileSync('git', ['fetch', '--tags', '--quiet', 'origin'])
      verifyFrom()
    } catch {
      // eslint-disable-next-line no-console
      console.error(`Range start ${from} does not resolve to a commit`)
      return 1
    }
  }

  const subjects = git('log', '--no-merges', '--encoding=UTF-8', '--pretty=%s', `${from}..${flags.to}`)
    .split('\n')
    .filter(Boolean)

  const notes = renderNotes({
    channel,
    repo: flags.repo,
    from,
    to: flags.to,
    subjects,
    baseVersion: git('show', `${flags.to}:package.json`)
      .toString()
      .match(/"version"\s*:\s*"([^"]+)"/)?.[1] ?? 'unversioned'
  })

  if (flags.out) {
    await writeFile(flags.out, notes, 'utf8')
    // eslint-disable-next-line no-console
    console.log(`release notes (${subjects.length} commits, ${from}..${flags.to}) -> ${flags.out}`)
  } else {
    process.stdout.write(notes)
  }
  return 0
}

// Only run main when executed directly (not when imported by tests).
// `pathToFileURL` keeps the comparison valid on Windows, where argv[1] is a
// backslash path and a naive `file://` prefix would never equal import.meta.url.
if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  process.exitCode = await main()
}
