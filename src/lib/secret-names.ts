/**
 * The one rule set for secret names, shared by the main process and the
 * renderer.
 *
 * Two questions are answered here and nowhere else:
 *
 * - Is this a name an OS environment variable may take at all?
 * - Is this a name the app may hand to a process, or one only the app may own?
 *
 * A name the app invents for itself is always namespaced under
 * {@link APP_ENVIRONMENT_PREFIX}, so an app-owned variable can never collide
 * with one the operating system, the Electron runtime, the user's shell, or a
 * launched harness already sets. The namespace works the other way too: a
 * secret collected from a user or named by an agent may never claim a `CIO_`
 * name and pass itself off as app state.
 */

/** Valid OS environment variable name. */
export const SECRET_ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** Every variable the app invents for itself starts here. */
export const APP_ENVIRONMENT_PREFIX = 'CIO_'

/** Longest name a collected secret may be exposed under. */
export const SECRET_ENVIRONMENT_VARIABLE_LIMIT = 64

/**
 * Names that are never a credential, because writing them changes how a
 * launched process resolves its own runtime instead of handing it a value.
 *
 * Matched case-insensitively: Windows environments are case-insensitive, so
 * `Path` is as dangerous as `PATH`.
 */
const RESERVED_ENVIRONMENT_NAMES: readonly string[] = [
  'PATH',
  'PATHEXT',
  'HOME',
  'USER',
  'USERNAME',
  'USERPROFILE',
  'LOGNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'SHELL',
  'IFS',
  'PWD',
  'OLDPWD',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TERM',
  'TERMINFO',
  'LANG',
  'LANGUAGE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_ENV',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONHOME',
  'PERL5LIB',
  'PERL5OPT',
  'RUBYOPT',
  'RUBYLIB',
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_EXEC_PATH',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'SSH_AUTH_SOCK',
  'SSH_ASKPASS',
  'CI'
]

/** Families where every member is reserved, matched by prefix. */
const RESERVED_ENVIRONMENT_PREFIXES: readonly string[] = ['LC_', 'XDG_', 'DYLD_', 'GIT_CONFIG']

const RESERVED_UPPER = new Set(RESERVED_ENVIRONMENT_NAMES.map((name) => name.toUpperCase()))

/** Whether this name belongs to the app's own `CIO_` namespace. */
export function isAppOwnedEnvironmentVariable(name: string): boolean {
  return name.trim().toUpperCase().startsWith(APP_ENVIRONMENT_PREFIX)
}

/** Whether the OS or a runtime already owns this name. */
export function isReservedEnvironmentName(name: string): boolean {
  const upper = name.trim().toUpperCase()
  if (!upper) return true
  if (RESERVED_UPPER.has(upper)) return true
  return RESERVED_ENVIRONMENT_PREFIXES.some((prefix) => upper.startsWith(prefix))
}

/** Reject a malformed or oversized name, and nothing else. */
export function assertEnvironmentVariableShape(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new TypeError('Secret environment variable must not be empty')
  if (trimmed.length > SECRET_ENVIRONMENT_VARIABLE_LIMIT) {
    throw new TypeError(
      `Secret environment variable must be at most ${SECRET_ENVIRONMENT_VARIABLE_LIMIT} characters`
    )
  }
  if (!SECRET_ENVIRONMENT_VARIABLE_PATTERN.test(trimmed)) {
    throw new TypeError(`Secret environment variable is not a valid OS variable name: ${trimmed}`)
  }
  return trimmed
}

/**
 * Validate a name a target expects, or one an agent asked for.
 *
 * A target may name its own variable (`GITHUB_PERSONAL_ACCESS_TOKEN`), so the
 * `CIO_` prefix is not required here. What is refused is every name the OS, a
 * runtime, or this app already owns, because a secret exposed under one of them
 * would redirect a process instead of authenticating it.
 */
export function validateTargetEnvironmentVariable(name: string): string {
  const validated = assertEnvironmentVariableShape(name)
  if (isAppOwnedEnvironmentVariable(validated)) {
    throw new TypeError(
      `Secret environment variable is reserved by the app and cannot be claimed: ${validated}`
    )
  }
  if (isReservedEnvironmentName(validated)) {
    throw new TypeError(
      `Secret environment variable is reserved by the OS or a runtime and cannot be overridden: ${validated}`
    )
  }
  return validated
}

/** Validate a variable the app is inventing for itself. */
export function validateAppEnvironmentVariable(name: string): string {
  const validated = assertEnvironmentVariableShape(name)
  if (!isAppOwnedEnvironmentVariable(validated)) {
    throw new TypeError(
      `App-owned environment variable must start with ${APP_ENVIRONMENT_PREFIX}: ${validated}`
    )
  }
  if (isReservedEnvironmentName(validated)) {
    throw new TypeError(`App-owned environment variable is a reserved OS name: ${validated}`)
  }
  return validated
}

/**
 * Reserved names a project's own ENV file may still set.
 *
 * A `.env` is where a project declares `NODE_ENV` and a locale; refusing those
 * would make the feature unusable. Everything else reserved stays refused, because
 * writing it changes how a launched server resolves its own runtime instead of
 * handing it a value.
 */
const PROJECT_ENV_ALLOWED_RESERVED: readonly string[] = ['NODE_ENV', 'LANG', 'LANGUAGE', 'CI']

/**
 * Validate a name a project's ENV file will inject into a server it starts.
 *
 * Tighter than a plain variable name, looser than a collected secret: a project may
 * legitimately declare `NODE_ENV`, but it may never declare `PATH`, `LD_PRELOAD` or
 * a name in the app's own `CIO_` namespace.
 */
export function validateProcessEnvironmentVariable(name: string): string {
  const validated = assertEnvironmentVariableShape(name)
  if (isAppOwnedEnvironmentVariable(validated)) {
    throw new TypeError(
      `Environment variable is reserved by the app and cannot be set by a project: ${validated}`
    )
  }
  if (isReservedEnvironmentName(validated)) {
    const allowed = PROJECT_ENV_ALLOWED_RESERVED.some(
      (entry) => entry.toUpperCase() === validated.toUpperCase()
    )
    if (!allowed) {
      throw new TypeError(
        `Environment variable is reserved by the OS or a runtime and cannot be overridden: ${validated}`
      )
    }
  }
  return validated
}

const TITLE_SLUG_LIMIT = 24

/**
 * The variable a collected secret is exposed under when the target did not name
 * one: `CIO_<id>_<TITLE_SLUG>`, where the per-secret id keeps two secrets with
 * the same title distinct.
 */
export function deriveAppEnvironmentVariable(id: string, title: string): string {
  const slug = title
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, TITLE_SLUG_LIMIT)
    .replace(/_+$/gu, '')
  const idSlug = id
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
  return validateAppEnvironmentVariable(`${APP_ENVIRONMENT_PREFIX}${idSlug}_${slug || 'SECRET'}`)
}
