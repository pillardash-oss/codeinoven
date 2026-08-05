import { execFile, spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, realpathSync } from 'fs'
import { stat, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { app, shell } from 'electron'
import { APP_SLUG } from '../lib/brand'
import { Logger } from './logger'
import type { EditorId, EditorInfo } from '../lib/types'

type TargetKind = 'directory' | 'file'

interface EditorDefinition {
  id: EditorId
  name: string
  /** CLI binary to resolve on the augmented PATH (when available). */
  cli?: string
  /** macOS application bundle names to probe in /Applications and ~/Applications. */
  macApps?: string[]
}

/** Known editors / terminals, in the order they appear in the picker. */
const EDITOR_DEFINITIONS: EditorDefinition[] = [
  { id: 'system', name: 'System Default' },
  { id: 'terminal', name: 'Terminal', macApps: ['Terminal'] },
  { id: 'iterm2', name: 'iTerm2', macApps: ['iTerm'] },
  { id: 'ghostty', name: 'Ghostty', cli: 'ghostty', macApps: ['Ghostty'] },
  { id: 'cmux', name: 'Cmux', cli: 'cmux', macApps: ['cmux'] },
  { id: 'warp', name: 'Warp', macApps: ['Warp'] },
  { id: 'kitty', name: 'Kitty', cli: 'kitty', macApps: ['kitty'] },
  { id: 'alacritty', name: 'Alacritty', cli: 'alacritty', macApps: ['Alacritty'] },
  { id: 'vscode', name: 'VS Code', cli: 'code', macApps: ['Visual Studio Code'] },
  { id: 'cursor', name: 'Cursor', cli: 'cursor', macApps: ['Cursor'] },
  { id: 'zed', name: 'Zed', cli: 'zed', macApps: ['Zed'] },
  { id: 'webstorm', name: 'WebStorm', cli: 'webstorm', macApps: ['WebStorm'] },
  { id: 'idea', name: 'IntelliJ IDEA', cli: 'idea', macApps: ['IntelliJ IDEA'] }
]

const TERMINAL_EDITOR_IDS = new Set<EditorId>([
  'terminal',
  'iterm2',
  'ghostty',
  'cmux',
  'warp',
  'kitty',
  'alacritty'
])

const SYSTEM_TERMINAL_CANDIDATES =
  process.platform === 'win32'
    ? ['wt.exe']
    : ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm']

/** Generous timeout — the first `swift` run pays a one-off compile cost (~3-5s). */
const HARVEST_TIMEOUT_MS = 20_000

/** Base64 PNG output for a dozen apps adds up — allow plenty of stdout. */
const HARVEST_MAX_BUFFER = 32 * 1024 * 1024

/**
 * Swift program that renders real app icons via NSWorkspace.icon(forFile:).
 * This is the only reliable route on macOS: Electron's app.getFileIcon returns
 * generic artwork for .app bundles, and apps like Terminal.app ship their icon
 * solely inside Assets.car (there is no .icns to parse).
 *
 * Protocol: one line per result — KIND<TAB>path<TAB>base64png. Passing the
 * `--default-folder-app` flag additionally emits the OS folder handler
 * (usually Finder) as a DEFAULT line.
 */
const ICON_HARVESTER_SWIFT = `
import AppKit

let side = 128
let tab = "\\t"

func b64Icon(_ path: String) -> String {
  let icon = NSWorkspace.shared.icon(forFile: path)
  guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side, bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0
  ) else { return "" }
  rep.size = NSSize(width: side, height: side)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  icon.draw(in: NSRect(x: 0, y: 0, width: side, height: side), from: .zero, operation: .copy, fraction: 1.0)
  NSGraphicsContext.restoreGraphicsState()
  guard let png = rep.representation(using: .png, properties: [:]) else { return "" }
  return png.base64EncodedString()
}

for arg in CommandLine.arguments.dropFirst() {
  if arg == "--default-folder-app" {
    let home = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
    if let appUrl = NSWorkspace.shared.urlForApplication(toOpen: home) {
      print("DEFAULT" + tab + appUrl.path + tab + b64Icon(appUrl.path))
    } else {
      print("DEFAULT" + tab + tab)
    }
  } else {
    print("ICON" + tab + arg + tab + b64Icon(arg))
  }
}
`

/**
 * EditorService — detects which editors/terminals are installed on this
 * machine and launches the user's preferred one against a project folder.
 *
 * Detection strategy:
 *  - CLI tools (`code`, `zed`, ...) are resolved via `which` on an augmented
 *    PATH (GUI apps don't inherit the user's shell PATH).
 *  - macOS app bundles are probed in /Applications, ~/Applications and the
 *    system utilities folder (Terminal.app).
 */
export class EditorService {
  /** PNG data-URLs keyed by app/binary path; `has()` marks paths already probed. */
  private iconCache = new Map<string, string | undefined>()
  /** OS folder handler: undefined = not probed yet, null = resolution failed. */
  private defaultHandler: { path: string; iconDataUrl?: string } | null | undefined
  private harvesterScriptPath: string | null = null
  private detectInFlight: Promise<EditorInfo[]> | null = null

  /** Pre-compile the Swift harvester and fill the icon cache (fire-and-forget). */
  warmUp(): void {
    // Test harnesses mock the electron module — nothing to warm up there.
    if (typeof app.getPath !== 'function') return
    void this.detect().catch((error: unknown) =>
      Logger.error('editor warm-up failed (non-fatal):', error)
    )
  }

  /** Detect all known editors, marking which are installed, with native app icons. */
  detect(): Promise<EditorInfo[]> {
    // Dedupe concurrent calls — warm-up and the UI share a single Swift spawn.
    this.detectInFlight ??= this.runDetect().finally(() => {
      this.detectInFlight = null
    })
    return this.detectInFlight
  }

  private async runDetect(): Promise<EditorInfo[]> {
    const nonSystem = EDITOR_DEFINITIONS.filter((def) => def.id !== 'system')
    const appPaths = new Map<EditorId, string | null>()
    await Promise.all(
      nonSystem.map(async (def) => {
        appPaths.set(def.id, await this.resolveAppPath(def))
      })
    )

    const paths = [...new Set([...appPaths.values()].filter((p): p is string => p !== null))]
    await this.harvestIcons(paths)

    const editors = nonSystem.map((def): EditorInfo => {
      const appPath = appPaths.get(def.id) ?? null
      return {
        id: def.id,
        name: def.name,
        available: appPath !== null,
        iconDataUrl: appPath ? this.iconCache.get(appPath) : undefined
      }
    })
    return [this.buildSystemEntry(), ...editors]
  }

  /** Open a filesystem target in the selected editor or terminal. */
  async openInEditor(
    editorId: EditorId,
    targetPath: string,
    targetKind: TargetKind = 'directory'
  ): Promise<void> {
    const resolvedTargetKind = await this.resolveTargetKind(targetPath, targetKind)
    const def = EDITOR_DEFINITIONS.find((d) => d.id === editorId)
    if (!def) {
      this.openSystemDefault(targetPath, resolvedTargetKind)
      return
    }

    if (def.id === 'system') {
      const systemTerminal = this.systemTerminalDefinition()
      if (resolvedTargetKind === 'file' && systemTerminal) {
        await this.openFileInTerminal(systemTerminal, targetPath)
      } else {
        this.openSystemDefault(targetPath, resolvedTargetKind)
      }
      return
    }

    if (resolvedTargetKind === 'file' && TERMINAL_EDITOR_IDS.has(editorId)) {
      await this.openFileInTerminal(def, targetPath)
      return
    }

    // On macOS, Ghostty handles opened directories by creating a session in
    // the running app. Its CLI does not communicate with an existing instance.
    if (process.platform === 'darwin' && def.id === 'ghostty') {
      this.openViaMacApp(def, targetPath)
      return
    }

    // Prefer the CLI when the editor ships one (code, zed, webstorm, ...).
    const cli = await this.resolveCli(def)
    if (cli) {
      try {
        const cliArgs = this.cliArgs(def, targetPath)
        const child = spawn(cli, cliArgs, {
          cwd: def.id === 'terminal' ? targetPath : undefined,
          env: this.buildEnv(),
          detached: true,
          stdio: 'ignore'
        })
        child.on('error', () => this.openViaMacApp(def, targetPath))
        child.unref()
        return
      } catch {
        // Fall through to the app-bundle launch below.
      }
    }

    this.openViaMacApp(def, targetPath)
  }

  /** Build CLI arguments for spawning an editor with a target directory. */
  private cliArgs(def: EditorDefinition, targetPath: string): string[] {
    switch (def.id) {
      case 'terminal':
        return []
      case 'ghostty':
        return [`--working-directory=${targetPath}`]
      case 'kitty':
        return [`--directory=${targetPath}`]
      case 'alacritty':
        return ['--working-directory', targetPath]
      default:
        return [targetPath]
    }
  }

  /** Launch Vim inside the selected terminal, rooted at the file's parent directory. */
  private async openFileInTerminal(def: EditorDefinition, targetPath: string): Promise<void> {
    const workingDirectory = dirname(targetPath)

    if (process.platform === 'darwin') {
      if (def.id === 'terminal' || def.id === 'iterm2') {
        this.openViaAppleScript(def, workingDirectory, targetPath)
        return
      }

      if (def.id === 'cmux') {
        const cli = await this.resolveCli(def)
        if (cli) {
          this.spawnTerminal(cli, [
            'new-workspace',
            '--cwd',
            workingDirectory,
            '--command',
            `vim ${this.quoteForShell(targetPath)}`,
            '--focus',
            'true'
          ])
          return
        }
      }

      if (def.id === 'warp') {
        await this.openFileViaWarp(def, workingDirectory, targetPath)
        return
      }

      this.openFileViaMacApp(def, workingDirectory, targetPath)
      return
    }

    const cli = await this.resolveCli(def)
    if (!cli) {
      void shell.openPath(targetPath)
      return
    }

    this.spawnTerminal(cli, this.terminalFileArgs(def, targetPath), workingDirectory)
  }

  private terminalFileArgs(def: EditorDefinition, targetPath: string): string[] {
    const shellArgs = this.shellEditorArgs(targetPath)
    switch (def.id) {
      case 'ghostty':
        return ['-e', ...shellArgs]
      case 'kitty':
        return shellArgs
      case 'alacritty':
        return ['-e', ...shellArgs]
      default:
        return process.platform === 'win32' ? ['vim', targetPath] : ['-e', ...shellArgs]
    }
  }

  private openFileViaMacApp(
    def: EditorDefinition,
    workingDirectory: string,
    targetPath: string
  ): void {
    if (!def.macApps?.length) {
      void shell.openPath(targetPath)
      return
    }

    const args = ['-na', def.macApps[0] ?? '', '--args']
    switch (def.id) {
      case 'ghostty':
        args.push(
          `--working-directory=${workingDirectory}`,
          `--initial-command=shell:${this.shellEditorCommand(targetPath)}`
        )
        break
      case 'kitty':
        args.push(`--directory=${workingDirectory}`, ...this.shellEditorArgs(targetPath))
        break
      case 'alacritty':
        args.push(
          '--working-directory',
          workingDirectory,
          '-e',
          ...this.shellEditorArgs(targetPath)
        )
        break
      default:
        args.push(
          '--working-directory',
          workingDirectory,
          '-e',
          ...this.shellEditorArgs(targetPath)
        )
    }
    this.spawnTerminal('open', args)
  }

  private async openFileViaWarp(
    def: EditorDefinition,
    workingDirectory: string,
    targetPath: string
  ): Promise<void> {
    const suffix = createHash('sha256').update(targetPath).digest('hex').slice(0, 16)
    const scriptPath = join(app.getPath('temp'), `${APP_SLUG}-vim-${suffix}.command`)
    const script = [
      '#!/bin/sh',
      `cd ${this.quoteForShell(workingDirectory)}`,
      `exec ${this.shellEditorCommand(targetPath)}`,
      ''
    ].join('\n')
    await writeFile(scriptPath, script, { encoding: 'utf-8', mode: 0o700 })
    this.spawnTerminal('open', ['-a', def.macApps?.[0] ?? 'Warp', scriptPath])

    setTimeout(() => {
      void unlink(scriptPath).catch((error: unknown) =>
        Logger.error('failed to remove temporary Warp Vim launcher:', error)
      )
    }, 60_000).unref()
  }

  private openViaAppleScript(
    def: EditorDefinition,
    workingDirectory: string,
    targetPath: string
  ): void {
    const commandExpression =
      '"cd " & quoted form of item 1 of argv & " && exec vim " & quoted form of item 2 of argv'
    const applicationLines =
      def.id === 'iterm2'
        ? [
            'tell application "iTerm"',
            'activate',
            `create window with default profile command (${commandExpression})`,
            'end tell'
          ]
        : [
            'tell application "Terminal"',
            'activate',
            `do script (${commandExpression})`,
            'end tell'
          ]
    const script = ['on run argv', ...applicationLines, 'end run']
    const args = script.flatMap((line) => ['-e', line])
    args.push(workingDirectory, targetPath)
    this.spawnTerminal('osascript', args)
  }

  private spawnTerminal(command: string, args: string[], cwd?: string): void {
    try {
      const child = spawn(command, args, {
        cwd,
        env: this.buildEnv(),
        detached: true,
        stdio: 'ignore'
      })
      child.on('error', (error) => Logger.error(`failed to launch terminal command:`, error))
      child.unref()
    } catch (error) {
      Logger.error(`failed to launch terminal command:`, error)
    }
  }

  private quoteForShell(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`
  }

  private shellEditorArgs(targetPath: string): string[] {
    return [this.userShell(), '-ilc', 'vim "$1"', APP_SLUG, targetPath]
  }

  private shellEditorCommand(targetPath: string): string {
    return this.shellEditorArgs(targetPath)
      .map((value) => this.quoteForShell(value))
      .join(' ')
  }

  private userShell(): string {
    return process.env['SHELL']?.trim() || '/bin/sh'
  }

  private async resolveTargetKind(targetPath: string, fallback: TargetKind): Promise<TargetKind> {
    try {
      return (await stat(targetPath)).isDirectory() ? 'directory' : 'file'
    } catch {
      return fallback
    }
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  /**
   * Resolve the .app bundle path for an editor definition.
   * Returns null when the editor cannot be found on this machine.
   */
  private async resolveAppPath(def: EditorDefinition): Promise<string | null> {
    const macPath = this.findMacAppPath(def.macApps ?? [])
    if (macPath) return macPath
    if (def.id === 'terminal') {
      return (await this.resolveCli(def)) ?? null
    }
    // CLI-only install — resolve the symlink; it often points inside a .app bundle.
    if (def.cli) {
      const located = await this.locateBinary(def.cli)
      if (located.found && located.path) {
        const bundle = this.bundleFromBinary(located.path)
        if (bundle) return bundle
        return located.path
      }
    }
    return null
  }

  private async resolveCli(def: EditorDefinition): Promise<string | null> {
    if (def.cli) {
      const located = await this.locateBinary(def.cli)
      if (located.found) return located.path ?? def.cli
    }

    if (def.id === 'cmux' && process.platform === 'darwin') {
      const appPath = this.findMacAppPath(def.macApps ?? [])
      if (appPath) {
        const bundledCli = join(appPath, 'Contents', 'Resources', 'bin', 'cmux')
        if (existsSync(bundledCli)) return bundledCli
      }
    }

    if (def.id === 'terminal' && process.platform !== 'darwin') {
      for (const candidate of SYSTEM_TERMINAL_CANDIDATES) {
        const located = await this.locateBinary(candidate)
        if (located.found) return located.path ?? candidate
      }
    }

    return null
  }

  /** If a CLI binary lives inside a .app bundle (via symlink), return the bundle path. */
  private bundleFromBinary(binPath: string): string | null {
    try {
      const real = realpathSync(binPath)
      const match = /(.+?\.app)\//.exec(real)
      if (match?.[1] && existsSync(match[1])) return match[1]
    } catch {
      // Symlink resolution failed — treat as bare binary.
    }
    return null
  }

  /** Probe common macOS application locations for a .app bundle; returns its path. */
  private findMacAppPath(appNames: string[]): string | null {
    if (process.platform !== 'darwin') return null
    const home = process.env['HOME'] ?? ''
    const roots = ['/Applications', join(home, 'Applications'), '/System/Applications/Utilities']
    for (const name of appNames) {
      for (const root of roots) {
        const candidate = join(root, `${name}.app`)
        if (existsSync(candidate)) return candidate
      }
    }
    return null
  }

  /** Extract the native application icon as a PNG data-URL via Electron. */
  private async getElectronIcon(targetPath: string): Promise<string | undefined> {
    try {
      const icon = await app.getFileIcon(targetPath, { size: 'normal' })
      return icon.toDataURL()
    } catch {
      return undefined
    }
  }

  /**
   * The 'system' entry mirrors the macOS default folder handler (usually
   * Finder) with its real name and icon; when resolution fails we fall back
   * to Terminal's identity instead of a generic "System Default" label.
   */
  private buildSystemEntry(): EditorInfo {
    if (this.defaultHandler) {
      return {
        id: 'system',
        name: this.appNameFromPath(this.defaultHandler.path),
        available: true,
        iconDataUrl: this.defaultHandler.iconDataUrl
      }
    }
    const terminalPath = this.findMacAppPath(['Terminal'])
    if (terminalPath) {
      return {
        id: 'system',
        name: 'Terminal',
        available: true,
        iconDataUrl: this.iconCache.get(terminalPath)
      }
    }
    return { id: 'system', name: 'System Default', available: true }
  }

  private systemTerminalDefinition(): EditorDefinition | null {
    if (process.platform !== 'darwin') return null

    const handlerName =
      this.defaultHandler === null
        ? 'Terminal'
        : this.defaultHandler
          ? this.appNameFromPath(this.defaultHandler.path)
          : null
    if (!handlerName) return null

    return (
      EDITOR_DEFINITIONS.find(
        (def) =>
          TERMINAL_EDITOR_IDS.has(def.id) &&
          (def.name === handlerName || def.macApps?.includes(handlerName))
      ) ?? null
    )
  }

  private appNameFromPath(appPath: string): string {
    return (
      appPath
        .split('/')
        .pop()
        ?.replace(/\.app$/, '') ?? 'System Default'
    )
  }

  /**
   * Open with the OS folder handler; when its resolution failed (the picker
   * shows Terminal in that case) launch Terminal so the UI stays truthful.
   */
  private openSystemDefault(targetPath: string, targetKind: TargetKind): void {
    if (
      process.platform === 'darwin' &&
      this.defaultHandler === null &&
      this.findMacAppPath(['Terminal'])
    ) {
      const launchTarget = targetKind === 'file' ? dirname(targetPath) : targetPath
      try {
        const child = spawn('open', ['-a', 'Terminal', launchTarget], {
          detached: true,
          stdio: 'ignore'
        })
        child.on('error', () => void shell.openPath(targetPath))
        child.unref()
        return
      } catch {
        // Fall through to the system handler below.
      }
    }
    void shell.openPath(targetPath)
  }

  /** Batch-render icons for every uncached path in a single Swift spawn. */
  private async harvestIcons(paths: string[]): Promise<void> {
    if (process.platform !== 'darwin') {
      if (this.defaultHandler === undefined) this.defaultHandler = null
      await this.harvestFallback(paths.filter((p) => !this.iconCache.has(p)))
      return
    }

    const pending = paths.filter((p) => !this.iconCache.has(p))
    const needDefault = this.defaultHandler === undefined
    if (pending.length === 0 && !needDefault) return

    try {
      const script = await this.ensureHarvesterScript()
      const args = needDefault ? ['--default-folder-app', ...pending] : pending
      this.ingestHarvest(await this.runSwift(script, args))
    } catch (error) {
      Logger.error('icon harvest via swift failed — using Electron fallback:', error)
    }

    // Anything the harvester missed (or a failed spawn) falls back to Electron.
    if (needDefault && this.defaultHandler === undefined) this.defaultHandler = null
    await this.harvestFallback(pending.filter((p) => this.iconCache.get(p) === undefined))
  }

  /** Electron's getFileIcon is generic for .app bundles, but better than nothing. */
  private async harvestFallback(paths: string[]): Promise<void> {
    await Promise.all(
      paths.map(async (p) => {
        this.iconCache.set(p, await this.getElectronIcon(p))
      })
    )
  }

  /** Parse the harvester's KIND<TAB>path<TAB>base64png protocol into the caches. */
  private ingestHarvest(stdout: string): void {
    for (const line of stdout.split('\n')) {
      const [kind, path, b64] = line.split('\t')
      const iconDataUrl = b64 ? `data:image/png;base64,${b64}` : undefined
      if (kind === 'ICON' && path) {
        this.iconCache.set(path, iconDataUrl)
      } else if (kind === 'DEFAULT') {
        this.defaultHandler = path ? { path, iconDataUrl } : null
      }
    }
  }

  /** Materialize the Swift source in the temp dir (once per session). */
  private async ensureHarvesterScript(): Promise<string> {
    if (this.harvesterScriptPath) return this.harvesterScriptPath
    const scriptPath = join(app.getPath('temp'), `${APP_SLUG}-icon-harvester.swift`)
    await writeFile(scriptPath, ICON_HARVESTER_SWIFT, 'utf-8')
    this.harvesterScriptPath = scriptPath
    return scriptPath
  }

  private runSwift(scriptPath: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'swift',
        [scriptPath, ...args],
        { timeout: HARVEST_TIMEOUT_MS, maxBuffer: HARVEST_MAX_BUFFER },
        (error, stdout) => {
          if (error) reject(error instanceof Error ? error : new Error(String(error)))
          else resolve(stdout)
        }
      )
    })
  }

  /** Launch via `open -a` on macOS, passing the directory with per-app flags. */
  private openViaMacApp(def: EditorDefinition, targetPath: string): void {
    if (process.platform !== 'darwin' || !def.macApps?.length) {
      void shell.openPath(targetPath)
      return
    }

    const args = ['-a', def.macApps[0] ?? '']
    switch (def.id) {
      case 'ghostty':
        args.push(targetPath)
        break
      case 'kitty':
        args.push('-n', '--args', `--directory=${targetPath}`)
        break
      case 'alacritty':
        args.push('-n', '--args', '--working-directory', targetPath)
        break
      default:
        // Terminal, iTerm2, Warp and GUI editors accept the path directly.
        args.push(targetPath)
    }

    try {
      const child = spawn('open', args, { detached: true, stdio: 'ignore' })
      child.on('error', () => {
        Logger.error(`failed to open "${def.name}" — falling back to system handler`)
        void shell.openPath(targetPath)
      })
      child.unref()
    } catch {
      void shell.openPath(targetPath)
    }
  }

  /** GUI apps don't inherit the shell PATH — augment with common install locations. */
  private buildEnv(): NodeJS.ProcessEnv {
    const home = process.env['HOME'] ?? ''
    const extraPaths = [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      `${home}/.local/bin`,
      `${home}/.bun/bin`,
      `${home}/.cargo/bin`,
      `${home}/.npm-global/bin`,
      `${home}/.nvm/current/bin`
    ]
    return { ...process.env, PATH: `${process.env['PATH'] ?? ''}:${extraPaths.join(':')}` }
  }

  private locateBinary(command: string): Promise<{ found: boolean; path?: string }> {
    const probe = process.platform === 'win32' ? 'where' : 'which'
    return new Promise((resolve) => {
      execFile(probe, [command], { env: this.buildEnv(), timeout: 5000 }, (error, stdout) => {
        if (error) {
          resolve({ found: false })
          return
        }
        const resolved = stdout.split('\n')[0]?.trim() ?? ''
        resolve({ found: true, path: resolved || undefined })
      })
    })
  }
}
