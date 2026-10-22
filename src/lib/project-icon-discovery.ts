import { opendir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, relative } from 'node:path'
import { toPosixPath } from './paths'

const ICON_SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  'coverage',
  'bower_components',
  '__pycache__',
  '.next',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.vscode',
  'target',
  '.venv',
  'venv',
  'Pods',
  'Carthage',
  '.gradle',
  '.dart_tool'
])

// Generated/build output dirs. Not traversed deeply, but their top-level files
// are still probed because many toolchains (Electron, webpack, Vite, .NET)
// copy or emit `icon.png`/`icon.ico`/`favicon.ico` into them.
const ICON_BUILD_DIRS = new Set(['build', 'dist', 'out', 'release', 'www'])

// Folder names that almost always hold a project's icon, anywhere in the tree.
const ICON_KNOWN_DIR_SEGMENTS = new Set([
  'src',
  'public',
  'static',
  'assets',
  'images',
  'img',
  'icons',
  'brand',
  'resources',
  'favicon',
  'favicons',
  'logos',
  'graphics',
  'app',
  'web',
  'client',
  'frontend',
  'site',
  'ui'
])

// Monorepo workspace containers. Icons found under these are scored slightly
// lower than icons in the project root so a root-level icon still wins.
const ICON_WORKSPACE_CONTAINERS = new Set([
  'packages',
  'apps',
  'modules',
  'libs',
  'components',
  'services',
  'tools',
  'sites',
  'examples'
])

const ICON_SCAN_DEPTH = 5

// Bounded scan: never read more than this many directories while hunting for
// an icon, so huge repositories can't stall project creation.
const ICON_MAX_SCAN_DIRS = 256

// Ranked icon filenames   earlier entries win. Names are matched
// case-insensitively so `Icon.PNG`, `FAVICON.ico`, etc. are all recognized.
const ICON_CANDIDATE_NAMES = [
  'favicon.png',
  'favicon.svg',
  'icon.png',
  'icon.svg',
  'icon-1024.png',
  'icon-1024x1024.png',
  'apple-touch-icon.png',
  'apple-touch-icon-precomposed.png',
  'app-icon.png',
  'app-icon.svg',
  'appicon.png',
  'logo.png',
  'logo.svg',
  'logo-mark.png',
  'logo-mark.svg',
  'logo-icon.png',
  'logo-icon.svg',
  'android-chrome-512x512.png',
  'android-chrome-192x192.png',
  'icon-512.png',
  'icon-192.png',
  'icon-128.png',
  'icon-96.png',
  'icon-72.png',
  'icon-48.png',
  'icon-32.png',
  'icon-16.png',
  'favicon-196x196.png',
  'favicon-160x160.png',
  'favicon-96x96.png',
  'favicon-32x32.png',
  'favicon-16x16.png',
  'logo-512.png',
  'logo-192.png',
  'mstile-150x150.png',
  'safari-pinned-tab.svg',
  'ic_launcher.png',
  'ic_launcher.webp',
  'ic_launcher_round.png',
  'ic_launcher_foreground.png',
  'favicon.ico',
  'icon.ico'
]

const ICON_CANDIDATE_RANK = new Map(
  ICON_CANDIDATE_NAMES.map((name, index) => [name.toLowerCase(), index])
)

// iOS `.appiconset` directories are a fallback-only source: the files inside
// have arbitrary names, so any PNG there ranks below a named icon anywhere.
const ICON_APPICONSET_PNG_RANK = 60

export class ProjectIconDiscovery {
  private remainingDirectories = ICON_MAX_SCAN_DIRS
  private remainingEntries = 20_000
  private readonly deadline = Date.now() + 1000

  private async entries(path: string): Promise<Dirent[]> {
    if (
      this.remainingDirectories-- <= 0 ||
      this.remainingEntries <= 0 ||
      Date.now() >= this.deadline
    )
      return []
    const entries: Dirent[] = []
    for await (const entry of await opendir(path)) {
      entries.push(entry)
      this.remainingEntries -= 1
      if (entries.length >= 10_000 || this.remainingEntries <= 0 || Date.now() >= this.deadline)
        break
    }
    return entries
  }

  /** Rank how promising a directory is for holding the project icon. */
  private iconLocationRank(relPath: string): number {
    if (relPath === '') return 0
    const segments = relPath.split('/')
    for (const segment of segments) {
      if (ICON_KNOWN_DIR_SEGMENTS.has(segment)) return 1
    }
    if (ICON_WORKSPACE_CONTAINERS.has(segments[0])) return 2
    return 3
  }

  /**
   * Bounded breadth-first scan across the project tree. Skips heavy/ignored
   * dirs and generated build outputs (those are probed shallowly instead).
   * Every candidate icon is scored (lower wins): filename rank dominates,
   * then location (root > known icon dirs > monorepo packages > arbitrary
   * nesting), then scan depth.
   */
  private async scanTreeForIcon(
    projectPath: string,
    consider: (path: string, score: number) => void
  ): Promise<void> {
    const queue: Array<{ dir: string; depth: number }> = [{ dir: projectPath, depth: 0 }]
    let scanned = 0

    while (queue.length > 0) {
      if (scanned >= ICON_MAX_SCAN_DIRS) break
      scanned++
      const { dir, depth } = queue.shift()!
      let entries: Dirent[]
      try {
        entries = await this.entries(dir)
      } catch {
        continue
      }

      const relDir = toPosixPath(relative(projectPath, dir))
      const locationRank = this.iconLocationRank(relDir)

      for (const entry of entries) {
        if (!entry.isFile()) continue
        const rank = ICON_CANDIDATE_RANK.get(entry.name.toLowerCase())
        if (rank === undefined) continue
        consider(join(dir, entry.name), rank * 1000 + locationRank * 100 + depth)
      }

      if (depth >= ICON_SCAN_DEPTH) continue

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        if (ICON_SKIP_DIRS.has(entry.name)) continue
        if (ICON_BUILD_DIRS.has(entry.name)) {
          // Build outputs are probed shallowly (Electron, webpack, Vite emit
          // their icon there), never traversed deeply.
          await this.probeDirForIcon(join(dir, entry.name), 2, consider)
          continue
        }
        if (queue.length < ICON_MAX_SCAN_DIRS)
          queue.push({ dir: join(dir, entry.name), depth: depth + 1 })
      }
    }
  }

  /** Shallow (depth ≤ 1) probe of a generated build output directory. */
  private async probeDirForIcon(
    dir: string,
    locationRank: number,
    consider: (path: string, score: number) => void
  ): Promise<void> {
    const queue: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }]
    let scanned = 0

    while (queue.length > 0 && scanned < 64) {
      scanned++
      const { dir: current, depth } = queue.shift()!
      let entries: Dirent[]
      try {
        entries = await this.entries(current)
      } catch {
        continue
      }

      for (const entry of entries) {
        if (!entry.isFile()) continue
        const rank = ICON_CANDIDATE_RANK.get(entry.name.toLowerCase())
        if (rank === undefined) continue
        consider(join(current, entry.name), rank * 1000 + locationRank * 100 + depth)
      }

      if (depth >= 1) continue

      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          if (queue.length < ICON_MAX_SCAN_DIRS)
            queue.push({ dir: join(current, entry.name), depth: depth + 1 })
        }
      }
    }
  }

  /** Android launcher icons live in `res/mipmap-…/ic_launcher.*`. */
  private async probeAndroidIcons(
    projectPath: string,
    consider: (path: string, score: number) => void
  ): Promise<void> {
    const resDir = join(projectPath, 'android', 'app', 'src', 'main', 'res')
    let entries: Dirent[]
    try {
      entries = await this.entries(resDir)
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('mipmap')) continue
      let files: Dirent[]
      try {
        files = await this.entries(join(resDir, entry.name))
      } catch {
        continue
      }
      for (const file of files) {
        if (!file.isFile()) continue
        const lower = file.name.toLowerCase()
        if (!(lower.startsWith('ic_launcher') && /\.(png|webp)$/.test(lower))) continue
        const rank = ICON_CANDIDATE_RANK.get(lower) ?? 100
        consider(join(resDir, entry.name, file.name), rank * 1000 + 100)
      }
    }
  }

  /** iOS app icons live in Xcode asset catalogs as `*.appiconset` dirs. */
  private async probeIosIcons(
    projectPath: string,
    consider: (path: string, score: number) => void
  ): Promise<void> {
    const queue: Array<{ dir: string; depth: number }> = [
      { dir: join(projectPath, 'ios'), depth: 0 }
    ]
    let scanned = 0

    while (queue.length > 0 && scanned < 500) {
      scanned++
      const { dir, depth } = queue.shift()!
      let entries: Dirent[]
      try {
        entries = await this.entries(dir)
      } catch {
        continue
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const full = join(dir, entry.name)
        if (entry.name.endsWith('.appiconset')) {
          await this.collectAppIconSet(full, consider)
        } else if (depth < 8 && !ICON_SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          if (queue.length < ICON_MAX_SCAN_DIRS) queue.push({ dir: full, depth: depth + 1 })
        }
      }
    }
  }

  /** Any PNG inside an `.appiconset` dir is a fallback icon candidate. */
  private async collectAppIconSet(
    dir: string,
    consider: (path: string, score: number) => void
  ): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await this.entries(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isFile() && /\.png$/i.test(entry.name)) {
        consider(join(dir, entry.name), ICON_APPICONSET_PNG_RANK * 1000 + 100)
      }
    }
  }

  async detectIcon(projectPath: string): Promise<string | null> {
    let best: { path: string; score: number } | null = null
    const consider = (path: string, score: number): void => {
      if (!best || score < best.score) best = { path, score }
    }
    for (const entry of await this.entries(projectPath)) {
      if (!entry.isFile()) continue
      const rank = ICON_CANDIDATE_RANK.get(entry.name.toLowerCase())
      if (rank !== undefined) consider(join(projectPath, entry.name), rank * 1000)
    }

    // Generated output dirs (Electron, webpack, Vite, .NET): probe shallowly.
    for (const buildDir of ICON_BUILD_DIRS) {
      await this.probeDirForIcon(join(projectPath, buildDir), 2, consider)
    }

    // Native platform icon locations.
    await this.probeAndroidIcons(projectPath, consider)
    await this.probeIosIcons(projectPath, consider)

    // Full tree scan: project root, src/static, public, assets, and monorepo
    // workspace packages.
    await this.scanTreeForIcon(projectPath, consider)

    return (best as { path: string; score: number } | null)?.path ?? null
  }
}
