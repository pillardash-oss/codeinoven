/**
 * Where a scoped utility is installed on disk.
 *
 * A utility scoped to a project lives inside that project's own scratch pad, so
 * the user sees the install next to the work it belongs to. A utility scoped to
 * a thread lives in that thread's own directory under the app config root, so it
 * is private to the conversation and removed with it. Both roots hold one folder
 * per utility, and every folder says which registry entry owns it so a sweep can
 * tell an install apart from a folder the user made.
 *
 * The shapes live here because the main-process installer and the editor's
 * "installs to" copy must agree on them.
 */

/** Folder a project's own scoped utilities are installed into, inside its `.cio`. */
export const PROJECT_UTILITIES_DIRECTORY = 'utilities'

/** Parent of every thread's utility directory, inside the app config root. */
export const CONFIG_UTILITIES_DIRECTORY = 'utilities'

/** Folder holding one directory per thread's utility installs, under the config root. */
export const THREAD_UTILITIES_DIRECTORY = 'threads'

/** Instructions file a skill install writes, the same name every harness reads. */
export const SKILL_INSTALL_FILE = 'SKILL.md'

/** Connection file an MCP server install writes. */
export const MCP_INSTALL_FILE = 'mcp.json'

/** Manifest every install folder carries, so the folder explains its own owner. */
export const UTILITY_INSTALL_MANIFEST = 'utility.json'

/** Manifest schema version, so a future shape change is readable, not guessed. */
export const UTILITY_INSTALL_MANIFEST_VERSION = 1

/**
 * Folder name one utility installs under: its transport name when a binding
 * carries one (a marketplace skill keeps its marketplace id), otherwise a slug
 * of its name. The installer appends a short id when two utilities would
 * otherwise claim one folder, so a name is never a reason to refuse an install.
 */
export function utilityInstallFolderName(name: string, transportName?: string | null): string {
  const candidate = (transportName ?? '').trim() || name
  const slug = candidate
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64)
    .replace(/-+$/gu, '')
  return slug || 'utility'
}
