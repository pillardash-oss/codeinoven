/**
 * The update command each well-known ACP agent's vendor documents.
 *
 * An ACP agent is the user's own binary, so the app never updates one on its
 * own: the vendor's documented command is handed to the embedded terminal. A
 * record the user saved before the update command existed (or one they never
 * filled in) still updates when its command belongs to a vendor listed here,
 * which is why this fallback sits between the record and the handoff.
 *
 * Verified against the real CLIs:
 *  - cline carries its updater as the `--update` flag (cline 3.0.61).
 *  - cursor-agent carries an `update` subcommand (cursor-agent 2026.09.10).
 */
const KNOWN_UPDATE_COMMANDS: Record<string, string> = {
  cline: 'cline --update',
  'cursor-agent': 'cursor-agent update'
}

/** The bare command an agent launches, for recipe lookup (`/usr/bin/cline` -> `cline`). */
export function acpCommandName(command: string): string {
  const base = command.split(/[\\/]/u).pop() ?? command
  return base.replace(/\.(exe|cmd|bat)$/iu, '').toLowerCase()
}

/**
 * The updater an agent runs: what its own record says, else its vendor's
 * documented one. Undefined when neither the user nor the app knows of one, so
 * every surface can hide or disable what it cannot offer.
 */
export function acpUpdateCommandFor(agent: {
  command: string
  updateCommand?: string
}): string | undefined {
  const configured = agent.updateCommand?.trim()
  if (configured) return configured
  return KNOWN_UPDATE_COMMANDS[acpCommandName(agent.command)]
}
