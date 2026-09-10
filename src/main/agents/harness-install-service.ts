import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { homedir } from 'os'
import type {
  HarnessInstallHandoff,
  HarnessInstallInfo,
  HarnessInstallMethod,
  HarnessUninstallHandoff,
  ProviderConnectionInfo
} from '../../lib/types'
import { findHarness } from './harness-registry'
import type { ProviderConnectionService } from '../providers/provider-connection'
import { prepareWslTerminalHandoff } from '../drivers/harness-runtime'
import { resolveExecutablePath } from '../drivers/cli-environment'

type Platform = NodeJS.Platform

/**
 * Official install/download page for each harness, keyed by OS. Where a
 * harness ships one canonical page that covers every platform (npm package
 * pages, single docs pages), the same URL is used for all three — the page
 * itself presents the OS-specific instructions. Pages were verified against
 * each harness's real install channels.
 */
const INSTALL_PAGES: Record<string, Partial<Record<Platform, string>>> = {
  opencode: {
    darwin: 'https://opencode.ai/download',
    linux: 'https://opencode.ai/download',
    win32: 'https://opencode.ai/download'
  },
  codex: {
    darwin: 'https://developers.openai.com/codex/cli/',
    linux: 'https://developers.openai.com/codex/cli/',
    win32: 'https://developers.openai.com/codex/cli/'
  },
  'claude-code': {
    darwin: 'https://docs.anthropic.com/en/docs/claude-code/setup',
    linux: 'https://docs.anthropic.com/en/docs/claude-code/setup',
    win32: 'https://docs.anthropic.com/en/docs/claude-code/setup'
  },
  pi: {
    darwin: 'https://github.com/earendil-works/pi',
    linux: 'https://github.com/earendil-works/pi',
    win32: 'https://github.com/earendil-works/pi'
  },
  cline: {
    darwin: 'https://www.npmjs.com/package/cline',
    linux: 'https://www.npmjs.com/package/cline',
    win32: 'https://www.npmjs.com/package/cline'
  },
  antigravity: {
    darwin: 'https://github.com/google-antigravity/antigravity-cli',
    linux: 'https://github.com/google-antigravity/antigravity-cli',
    win32: 'https://github.com/google-antigravity/antigravity-cli'
  },
  muse: {
    darwin: 'https://developer.meta.com/ai/products/muse-code/',
    linux: 'https://developer.meta.com/ai/products/muse-code/',
    win32: 'https://developer.meta.com/ai/products/muse-code/'
  }
}

/** The install methods each harness officially documents per platform. */
const INSTALL_METHODS: Record<string, Partial<Record<Platform, HarnessInstallMethod[]>>> = {
  opencode: {
    darwin: ['npm', 'brew', 'native'],
    linux: ['npm', 'brew', 'native'],
    win32: ['npm', 'native']
  },
  codex: {
    darwin: ['npm', 'brew', 'native'],
    linux: ['npm', 'brew', 'native'],
    win32: ['npm', 'native']
  },
  'claude-code': {
    darwin: ['npm', 'brew', 'native'],
    linux: ['npm', 'brew', 'native'],
    win32: ['npm', 'native', 'winget']
  },
  pi: {
    darwin: ['npm', 'native'],
    linux: ['npm', 'native'],
    win32: ['npm', 'native']
  },
  cline: {
    darwin: ['npm'],
    linux: ['npm'],
    win32: ['npm']
  },
  antigravity: {
    darwin: ['native'],
    linux: ['native'],
    win32: ['native']
  },
  muse: {
    darwin: ['native'],
    linux: ['native'],
    win32: ['native']
  }
}

/**
 * Documented uninstall commands per install method. CodeInOven never mutates a
 * harness install on its own — these hand off the harness's own documented
 * removal command to the user-controlled embedded terminal, exactly like the
 * update flow. `~` is expanded to the user's home directory at handoff build
 * time so the direct-spawn PTY gets an absolute path.
 */
const UNINSTALL_COMMANDS: Record<
  string,
  Partial<Record<HarnessInstallMethod, { command: string; args: string[] }>>
> = {
  opencode: {
    npm: { command: 'npm', args: ['uninstall', '-g', 'opencode-ai'] },
    brew: { command: 'brew', args: ['uninstall', 'anomalyco/tap/opencode'] },
    native: { command: 'rm', args: ['-rf', '~/.opencode'] }
  },
  codex: {
    npm: { command: 'npm', args: ['uninstall', '-g', '@openai/codex'] },
    brew: { command: 'brew', args: ['uninstall', '--cask', 'codex'] },
    native: { command: 'rm', args: ['-rf', '~/.codex'] }
  },
  'claude-code': {
    native: {
      command: 'rm',
      args: ['-rf', '~/.local/bin/claude', '~/.local/share/claude']
    },
    npm: { command: 'npm', args: ['uninstall', '-g', '@anthropic-ai/claude-code'] },
    brew: { command: 'brew', args: ['uninstall', '--cask', 'claude-code'] },
    winget: { command: 'winget', args: ['uninstall', 'Anthropic.ClaudeCode'] }
  },
  pi: {
    npm: { command: 'npm', args: ['uninstall', '-g', '@earendil-works/pi-coding-agent'] },
    native: { command: 'rm', args: ['-rf', '~/.pi'] }
  },
  cline: {
    npm: { command: 'npm', args: ['uninstall', '-g', 'cline'] },
    native: { command: 'rm', args: ['-rf', '~/.cline'] }
  },
  antigravity: {
    native: { command: 'rm', args: ['-rf', '~/.local/bin/agy', '~/.antigravity'] }
  },
  muse: {
    native: {
      command: 'rm',
      args: ['-rf', '~/.local/bin/muse', '~/.config/muse', '~/.local/share/muse']
    }
  }
}

/**
 * Documented install commands per install method, keyed by platform where the
 * command differs. Native installers are preferred on Windows so users never
 * need Node.js just to install a CLI. Commands were verified against each
 * harness's real install channels.
 */
const INSTALL_COMMANDS: Record<
  string,
  Partial<Record<Platform, Partial<Record<HarnessInstallMethod, { command: string; args: string[] }>>>>
> = {
  opencode: {
    darwin: {
      npm: { command: 'npm', args: ['install', '-g', 'opencode-ai'] },
      brew: { command: 'brew', args: ['install', 'anomalyco/tap/opencode'] },
      native: { command: 'sh', args: ['-lc', 'curl -fsSL https://opencode.ai/install | bash'] }
    },
    linux: {
      npm: { command: 'npm', args: ['install', '-g', 'opencode-ai'] },
      native: { command: 'sh', args: ['-lc', 'curl -fsSL https://opencode.ai/install | bash'] }
    },
    win32: {
      native: {
        command: 'powershell',
        args: ['-NoProfile', '-Command', 'irm https://opencode.ai/install.ps1 | iex']
      },
      npm: { command: 'npm', args: ['install', '-g', 'opencode-ai'] }
    }
  },
  codex: {
    darwin: {
      npm: { command: 'npm', args: ['install', '-g', '@openai/codex'] },
      brew: { command: 'brew', args: ['install', '--cask', 'codex'] }
    },
    linux: {
      npm: { command: 'npm', args: ['install', '-g', '@openai/codex'] },
      brew: { command: 'brew', args: ['install', '--cask', 'codex'] }
    },
    win32: {
      npm: { command: 'npm', args: ['install', '-g', '@openai/codex'] }
    }
  },
  'claude-code': {
    darwin: {
      npm: { command: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'] },
      brew: { command: 'brew', args: ['install', '--cask', 'claude-code'] }
    },
    linux: {
      npm: { command: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'] }
    },
    win32: {
      winget: { command: 'winget', args: ['install', 'Anthropic.ClaudeCode'] },
      npm: { command: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'] }
    }
  },
  pi: {
    darwin: {
      npm: { command: 'npm', args: ['install', '-g', '@earendil-works/pi-coding-agent'] }
    },
    linux: {
      npm: { command: 'npm', args: ['install', '-g', '@earendil-works/pi-coding-agent'] }
    },
    win32: {
      npm: { command: 'npm', args: ['install', '-g', '@earendil-works/pi-coding-agent'] }
    }
  },
  cline: {
    darwin: { npm: { command: 'npm', args: ['install', '-g', 'cline'] } },
    linux: { npm: { command: 'npm', args: ['install', '-g', 'cline'] } },
    win32: { npm: { command: 'npm', args: ['install', '-g', 'cline'] } }
  }
}

/** Install methods in preference order per platform — native installers first on Windows. */
const METHOD_PREFERENCE: Record<Platform, HarnessInstallMethod[]> = {
  win32: ['winget', 'native', 'npm'],
  darwin: ['brew', 'npm'],
  linux: ['npm']
}

/** Documented winget id for bootstrapping Node.js when an npm install needs it. */
const NODE_WINGET_PACKAGE = 'OpenJS.NodeJS.LTS'

const NPM_PATH_MARKERS = ['node_modules', '.npm-global', 'nvm/versions', 'pnpm']
const BREW_PATH_MARKERS = ['Cellar', 'homebrew']

/**
 * Resolve the install method from the resolved binary path when it can be told
 * apart, falling back to the harness's primary documented method otherwise.
 */
function detectMethod(
  harnessId: string,
  resolvedPath: string | undefined,
  executionTarget?: ProviderConnectionInfo['executionTarget']
): HarnessInstallMethod {
  if (executionTarget?.kind === 'bundled') return 'bundled'
  if (!resolvedPath) return primaryMethod(harnessId)
  const lower = resolvedPath.toLowerCase()
  if (NPM_PATH_MARKERS.some((marker) => lower.includes(marker))) return 'npm'
  if (BREW_PATH_MARKERS.some((marker) => lower.includes(marker))) return 'brew'
  if (process.platform === 'win32' && lower.includes('windowsapps')) return 'winget'
  return primaryMethod(harnessId)
}

/** The first method each harness documents for the current platform. */
function primaryMethod(harnessId: string): HarnessInstallMethod {
  const methods = INSTALL_METHODS[harnessId]?.[process.platform] ?? ['native']
  return methods[0] ?? 'native'
}

function expandHome(args: string[]): string[] {
  const home = homedir()
  return args.map((arg) => (arg === '~' ? home : arg.replace(/^~(?=\/|$)/u, home)))
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`
}

function wslShellArgument(value: string): string {
  return value.startsWith('~/') ? `"$HOME"/${shellQuote(value.slice(2))}` : shellQuote(value)
}

/**
 * Provides install pages and uninstall handoffs for the coding harnesses.
 * Like the update flow, main never executes an install or uninstall on its
 * own: it hands the user a download page (install) or the harness's own
 * documented removal command (uninstall) to run in the embedded terminal.
 */
export class HarnessInstallService {
  constructor(private providers: ProviderConnectionService) {}

  register(): void {
    ipcMain.handle('harnessInstall:getInfo', (_, rawHarnessId: unknown) =>
      this.getInfo(this.harnessId(rawHarnessId))
    )
    ipcMain.handle('harnessInstall:handoff', (_, rawHarnessId: unknown) =>
      this.installHandoff(this.harnessId(rawHarnessId))
    )
    ipcMain.handle('harnessUninstall:handoff', (_, rawHarnessId: unknown) =>
      this.uninstallHandoff(this.harnessId(rawHarnessId))
    )
  }

  /** OS-specific install page + documented methods for the current platform. */
  getInfo(harnessId: string): HarnessInstallInfo {
    const definition = findHarness(harnessId)
    if (!definition) throw new Error(`Unknown harness: ${harnessId}`)
    const provider = this.providers.getAll().find((candidate) => candidate.id === harnessId)
    const platform: Platform =
      provider?.executionTarget?.kind === 'wsl' ? 'linux' : process.platform
    const pageUrl = INSTALL_PAGES[harnessId]?.[platform] ?? INSTALL_PAGES[harnessId]?.linux
    if (!pageUrl) throw new Error(`No install page is configured for harness: ${harnessId}`)

    const detectedMethod =
      provider?.status === 'available'
        ? detectMethod(harnessId, provider.resolvedPath, provider.executionTarget)
        : undefined

    return {
      harnessId,
      pageUrl,
      methods: INSTALL_METHODS[harnessId]?.[platform] ?? [],
      ...(detectedMethod ? { detectedMethod } : {})
    }
  }

  /** Build, but do not execute, the one-click install handoff for the embedded terminal. */
  async installHandoff(harnessId: string): Promise<HarnessInstallHandoff> {
    const definition = findHarness(harnessId)
    if (!definition) throw new Error(`Unknown harness: ${harnessId}`)

    const provider = this.providers.getAll().find((candidate) => candidate.id === harnessId)
    if (provider?.status === 'available') {
      throw new Error(`${definition.name} is already installed.`)
    }
    if (provider?.executionTarget?.kind === 'bundled') {
      throw new Error(`${definition.name} is bundled with CodeInOven and needs no install.`)
    }

    const wslTarget = provider?.executionTarget?.kind === 'wsl' ? provider.executionTarget : undefined
    const platform: Platform = wslTarget ? 'linux' : process.platform
    const platformCommands = INSTALL_COMMANDS[harnessId]?.[platform]
    const method = METHOD_PREFERENCE[platform].find((candidate) => platformCommands?.[candidate])
    const command = method ? platformCommands?.[method] : undefined
    if (!method || !command) {
      throw new Error(
        `No one-click install is documented for ${definition.name} on this platform — use the install page instead.`
      )
    }

    let resolved = { ...command, method }
    if (method === 'npm' && !wslTarget && resolveExecutablePath('node') === undefined) {
      resolved = this.withNodeBootstrap(definition.name, resolved, platform)
    }

    if (wslTarget) {
      const script = [resolved.command, ...resolved.args]
        .map((value) => wslShellArgument(value))
        .join(' ')
      const prepared = prepareWslTerminalHandoff(wslTarget.distribution, 'sh', ['-lc', script])
      return {
        kind: 'terminal',
        command: prepared.command,
        args: prepared.args,
        title: `Install ${definition.name}`,
        method
      }
    }

    return {
      kind: 'terminal',
      command: resolved.command,
      args: resolved.args,
      title: `Install ${definition.name}`,
      method
    }
  }

  /**
   * Wrap an npm install in the platform's documented Node.js bootstrap when no
   * Node runtime was found — Windows via winget, macOS via Homebrew. On Linux,
   * or when no bootstrap channel exists, explain what the user needs instead.
   */
  private withNodeBootstrap(
    harnessName: string,
    command: { command: string; args: string[]; method: HarnessInstallMethod },
    platform: Platform
  ): { command: string; args: string[]; method: HarnessInstallMethod } {
    const npmPackage = command.args[command.args.length - 1]
    if (!npmPackage) {
      throw new Error(`No npm package is configured for ${harnessName}.`)
    }
    if (platform === 'win32' && resolveExecutablePath('winget')) {
      return {
        method: command.method,
        command: 'cmd',
        args: [
          '/d',
          '/s',
          '/c',
          `winget install ${NODE_WINGET_PACKAGE} --accept-source-agreements --accept-package-agreements && npm install -g ${npmPackage}`
        ]
      }
    }
    if (platform === 'darwin' && resolveExecutablePath('brew')) {
      return {
        method: command.method,
        command: 'sh',
        args: ['-lc', `brew install node && npm install -g ${npmPackage}`]
      }
    }
    throw new Error(
      `${harnessName} installs via npm, but Node.js was not found on this machine. Install Node.js from https://nodejs.org and try again.`
    )
  }

  /** Build, but do not execute, the uninstall handoff for the embedded terminal. */
  async uninstallHandoff(harnessId: string): Promise<HarnessUninstallHandoff> {
    const definition = findHarness(harnessId)
    if (!definition) throw new Error(`Unknown harness: ${harnessId}`)

    const provider = this.providers.getAll().find((candidate) => candidate.id === harnessId)
    if (!provider || provider.status !== 'available') {
      throw new Error(`${definition.name} is not installed — nothing to uninstall.`)
    }
    if (provider.executionTarget?.kind === 'bundled') {
      throw new Error(
        `${definition.name} is bundled with CodeInOven and cannot be uninstalled separately.`
      )
    }

    const method = detectMethod(harnessId, provider.resolvedPath)
    const command = UNINSTALL_COMMANDS[harnessId]?.[method]
    if (!command) {
      throw new Error(
        `No documented uninstall command exists for ${definition.name} (${method} install).`
      )
    }

    if (provider.executionTarget?.kind === 'wsl') {
      const script = [command.command, ...command.args]
        .map((value) => wslShellArgument(value))
        .join(' ')
      const prepared = prepareWslTerminalHandoff(provider.executionTarget.distribution, 'sh', [
        '-lc',
        script
      ])
      return {
        kind: 'terminal',
        command: prepared.command,
        args: prepared.args,
        title: `Uninstall ${definition.name}`,
        method
      }
    }

    return {
      kind: 'terminal',
      command: command.command,
      args: expandHome(command.args),
      title: `Uninstall ${definition.name}`,
      method
    }
  }

  private harnessId(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
      throw new TypeError('Harness ID is invalid')
    }
    return value.trim()
  }
}
