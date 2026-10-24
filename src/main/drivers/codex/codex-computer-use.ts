import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { runHarnessCommand } from '../harness-runtime'
import { tomlString, tomlStringArray } from './codex-tools'

/**
 * Codex's own computer use, as this machine actually has it.
 *
 * Codex does not carry computer use inside the CLI: it ships it as an MCP server
 * (`computer-use`) written into the Codex home by the Codex desktop app, and that
 * entry is as often disabled as it is missing, while an app-managed Codex home
 * has no entry at all. A capability claim has to come from the device, never from
 * the driver's own opinion, because the utility registry suppresses the app-owned
 * CUA driver for every harness that claims computer use natively.
 */
export interface CodexComputerUseReadiness {
  available: boolean
  /** Why the answer is what it is, for the driver's diagnostics log. */
  reason: string
  /** `key=value` config overrides that turn Codex's computer use on for one launch. */
  configOverrides: string[]
}

/** One MCP server from `codex mcp list --json`, narrowed to the fields we read. */
interface CodexMcpServerListing {
  name: string
  /** Whether Codex is configured to load this server at all. */
  enabled: boolean
  transport: {
    type: string
    command?: string
    args?: string[]
    cwd?: string | null
  } | null
}

const COMPUTER_USE_NAME = /computer[-_ ]?use/iu
const PROBE_TIMEOUT_MS = 8_000
/** The directory Codex installs the computer-use helper into, inside its home. */
const COMPUTER_USE_DIRECTORY = 'computer-use'
/** The config key Codex's desktop app writes, and the one we enable. */
const FALLBACK_SERVER_NAME = 'computer-use'

export const CODEX_COMPUTER_USE_UNAVAILABLE: CodexComputerUseReadiness = {
  available: false,
  reason: 'Codex has no computer-use server configured',
  configOverrides: []
}

/**
 * Whether Codex can supply computer use on this machine, and the config that
 * turns it on when it can.
 *
 * The probe asks Codex itself (`codex mcp list --json`) instead of parsing the
 * Codex TOML, so a config shape we do not model still answers correctly, and a
 * resolved command is then checked on disk: an entry pointing at an uninstalled
 * helper is not a capability.
 *
 * A server Codex is told not to load is not a capability either. The Codex
 * desktop app writes the entry and leaves it disabled whenever computer use is
 * off, and a disabled entry never reaches the model, so claiming it would
 * suppress the app-owned CUA driver for a turn that has no desktop control at
 * all.
 */
export async function probeCodexComputerUse(options: {
  env: NodeJS.ProcessEnv
  cwd: string
}): Promise<CodexComputerUseReadiness> {
  const homes = probeHomes(options.env)
  let reason = CODEX_COMPUTER_USE_UNAVAILABLE.reason
  for (const home of homes) {
    const server = await listComputerUseServer(options, home)
    if (!server) {
      reason = `Codex has no computer-use server configured in ${home.label}`
      continue
    }
    if (!server.enabled) {
      reason = `Codex computer use is turned off in ${home.label}`
      continue
    }
    const resolved = await resolveHelper(server, home.path)
    if (!resolved) {
      reason = `Codex's computer-use server in ${home.label} points at a helper that is not installed`
      continue
    }
    return {
      available: true,
      reason: `Codex computer use is enabled in ${home.label}`,
      configOverrides: [
        `mcp_servers.${serverKey(server.name)}.enabled=true`,
        `mcp_servers.${serverKey(server.name)}.command=${tomlString(resolved.command)}`,
        `mcp_servers.${serverKey(server.name)}.args=${tomlStringArray(resolved.args)}`,
        `mcp_servers.${serverKey(server.name)}.cwd=${tomlString(resolved.cwd)}`
      ]
    }
  }
  return { ...CODEX_COMPUTER_USE_UNAVAILABLE, reason }
}

/** Where Codex keeps its config: the account home first, then the device default. */
function probeHomes(env: NodeJS.ProcessEnv): Array<{ label: string; path: string }> {
  const homes: Array<{ label: string; path: string }> = []
  const accountHome = env['CODEX_HOME']?.trim()
  const deviceHome = join(homedir(), '.codex')
  if (accountHome) homes.push({ label: 'the Codex account home', path: accountHome })
  if (deviceHome !== accountHome)
    homes.push({ label: 'the device Codex install', path: deviceHome })
  return homes
}

async function listComputerUseServer(
  options: { env: NodeJS.ProcessEnv; cwd: string },
  home: { path: string }
): Promise<CodexMcpServerListing | null> {
  let stdout: string
  try {
    const result = await runHarnessCommand('codex', ['mcp', 'list', '--json'], {
      cwd: options.cwd,
      env: { ...options.env, CODEX_HOME: home.path },
      timeoutMs: PROBE_TIMEOUT_MS
    })
    stdout = result.stdout
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const listing = entry as Partial<CodexMcpServerListing>
    if (typeof listing.name !== 'string' || !COMPUTER_USE_NAME.test(listing.name)) continue
    return {
      name: listing.name,
      enabled: listing.enabled === true,
      transport:
        listing.transport && typeof listing.transport === 'object' ? listing.transport : null
    }
  }
  return null
}

/**
 * The helper a listing actually launches, with its relative command resolved to a
 * real executable.
 *
 * Codex writes its own entry relative (`./Codex Computer Use.app/...`), and that
 * path resolves from its managed computer-use directory, not from the Codex home
 * itself, because Codex ships the helper into `${CODEX_HOME}/computer-use`.
 * An app-managed Codex home has no such entry at all, so the launch needs the
 * absolute form to reach the helper the device actually installed.
 */
async function resolveHelper(
  server: CodexMcpServerListing,
  home: string
): Promise<{ command: string; args: string[]; cwd: string } | null> {
  const rawCommand = server.transport?.command?.trim()
  if (!rawCommand) return null
  const args = server.transport?.args ?? []
  if (isAbsolute(rawCommand)) {
    return (await isExecutable(rawCommand))
      ? { command: rawCommand, args, cwd: resolve(home, server.transport?.cwd?.trim() || '.') }
      : null
  }
  const bases = [
    resolve(home, COMPUTER_USE_DIRECTORY),
    resolve(home, server.transport?.cwd?.trim() || '.')
  ]
  for (const base of bases) {
    const command = resolve(base, rawCommand)
    if (await isExecutable(command)) return { command, args, cwd: base }
  }
  return null
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Codex config keys are dotted paths, so a name with a dot or space cannot be one. */
function serverKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(name) ? name : FALLBACK_SERVER_NAME
}
