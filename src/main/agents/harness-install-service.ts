import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { homedir } from 'os'
import type {
  HarnessInstallInfo,
  HarnessInstallMethod,
  HarnessUninstallHandoff
} from '../../lib/types'
import { findHarness } from './harness-registry'
import type { ProviderConnectionService } from '../providers/provider-connection'

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

const NPM_PATH_MARKERS = ['node_modules', '.npm-global', 'nvm/versions', 'pnpm']
const BREW_PATH_MARKERS = ['Cellar', 'homebrew']

/**
 * Resolve the install method from the resolved binary path when it can be told
 * apart, falling back to the harness's primary documented method otherwise.
 */
function detectMethod(harnessId: string, resolvedPath: string | undefined): HarnessInstallMethod {
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
    ipcMain.handle('harnessUninstall:handoff', (_, rawHarnessId: unknown) =>
      this.uninstallHandoff(this.harnessId(rawHarnessId))
    )
  }

  /** OS-specific install page + documented methods for the current platform. */
  getInfo(harnessId: string): HarnessInstallInfo {
    const definition = findHarness(harnessId)
    if (!definition) throw new Error(`Unknown harness: ${harnessId}`)
    const platform = process.platform as Platform
    const pageUrl = INSTALL_PAGES[harnessId]?.[platform] ?? INSTALL_PAGES[harnessId]?.linux
    if (!pageUrl) throw new Error(`No install page is configured for harness: ${harnessId}`)

    const provider = this.providers.getAll().find((candidate) => candidate.id === harnessId)
    const detectedMethod =
      provider?.status === 'available' ? detectMethod(harnessId, provider.resolvedPath) : undefined

    return {
      harnessId,
      pageUrl,
      methods: INSTALL_METHODS[harnessId]?.[platform] ?? [],
      ...(detectedMethod ? { detectedMethod } : {})
    }
  }

  /** Build, but do not execute, the uninstall handoff for the embedded terminal. */
  uninstallHandoff(harnessId: string): HarnessUninstallHandoff {
    const definition = findHarness(harnessId)
    if (!definition) throw new Error(`Unknown harness: ${harnessId}`)

    const provider = this.providers.getAll().find((candidate) => candidate.id === harnessId)
    if (!provider || provider.status !== 'available') {
      throw new Error(`${definition.name} is not installed — nothing to uninstall.`)
    }

    const method = detectMethod(harnessId, provider.resolvedPath)
    const command = UNINSTALL_COMMANDS[harnessId]?.[method]
    if (!command) {
      throw new Error(
        `No documented uninstall command exists for ${definition.name} (${method} install).`
      )
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
