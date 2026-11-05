import { getAgentIcon } from './registry'
import type { AgentIconEntry } from './agent-registry'
import { getVendorIconSvg, getVendorSlug } from '../vendor-icons/registry'

/**
 * Which shipped mark an ACP agent's own command stands for.
 *
 * An ACP agent is a command, not a product the app knows: `cursor-agent acp` and
 * `cline --acp` reach us the same way. When that command names a harness we
 * already ship artwork for, the agent wears that mark instead of a generic one,
 * so a user who added Cline over ACP sees Cline. Anything else falls back to the
 * app's own vendor icon, which is what the CodeInOven icon asset carries.
 */
const COMMAND_MARKS: Record<string, string> = {
  agy: 'antigravity',
  antigravity: 'antigravity',
  claude: 'claude-code',
  'claude-code': 'claude-code',
  cline: 'cline',
  codex: 'codex',
  muse: 'muse',
  opencode: 'opencode',
  pi: 'pi'
}

/** Executable name of a command line, without its directory or Windows suffix. */
export function commandName(command: string): string {
  const last = command.trim().toLowerCase().split(/[\\/]/u).pop() ?? ''
  return last.replace(/\.(exe|cmd|bat)$/u, '')
}

/** The bundled harness mark for an agent command, when the app ships one. */
export function harnessMarkForCommand(command: string): AgentIconEntry | undefined {
  const markId = COMMAND_MARKS[commandName(command)]
  return markId ? getAgentIcon(markId) : undefined
}

/**
 * Vendor slug the app's own mark is registered under, and the answer when an
 * agent's command belongs to no bundled vendor.
 */
export const APP_VENDOR_SLUG = 'codeinoven'

/**
 * Vendor slug whose bundled brand icon an agent should preview in the editor.
 *
 * The command comes first (an agent pointed at `cline` is Cline), then the
 * name the user gave it. A slug with no bundled artwork is not previewed: a
 * monogram of the user's own words is not a vendor mark, so the CodeInOven icon
 * answers instead.
 */
export function vendorIconSlugFor(command: string, name: string): string {
  const candidates = [commandName(command), name]
  for (const candidate of candidates) {
    const markId = COMMAND_MARKS[candidate.trim().toLowerCase()]
    if (markId) {
      // A harness mark id is not always a vendor slug (`claude-code` vs
      // `claudecode`), so it is normalized through the same lookup.
      const fromMark = getVendorSlug(markId)
      if (fromMark && getVendorIconSvg(markId)) return fromMark
    }
    const slug = getVendorSlug(candidate)
    if (slug && getVendorIconSvg(candidate)) return slug
  }
  return APP_VENDOR_SLUG
}
