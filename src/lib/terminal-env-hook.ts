/**
 * The shell-hook contract that lets a project's inject rule reach an interactive
 * terminal.
 *
 * A terminal is spawned before the user has typed anything, so the app cannot know
 * which command will run and cannot narrow the environment at spawn. Instead the
 * shell announces each accepted line to the app, the app answers with the values
 * that line's rule admits, and the values live for exactly that command.
 *
 * The transport is files in one private session directory:
 *
 *     <dir>/req.<n>     the shell writes "$PWD\n<command line>" and renames it in
 *     <dir>/res.<n>     the app writes exports and renames it in
 *     <dir>/names.<n>   the names the app exported, one per line
 *
 * Renames keep every file whole on both sides, and no FIFO, `nc` or extra binary
 * is needed: `printf`, `mv`, `source` and `rm` exist in every shell that can hold
 * this hook. Values are written as a sourceable snippet, because a secret may
 * contain a newline (a private key) and a line-based format would tear it apart.
 *
 * This module is pure: it decides which shell can hold the hook, what the hook
 * says, and how a response is spelled. Nothing here touches the filesystem.
 */

/** The shells whose startup can be given a pre-exec hook. */
export type TerminalEnvHookShell = 'zsh' | 'bash' | 'fish'

/** The request marker the app watches for. */
export const TERMINAL_ENV_HOOK_DIRECTORY = 'CIO_ENV_HOOK_DIR'

/** Longest command line the app will answer, so a paste cannot become a payload. */
export const TERMINAL_ENV_HOOK_COMMAND_LIMIT = 100_000

/** The shell name without its directory or an `.exe` suffix. */
function shellName(shellPath: string): string {
  const normalized = shellPath.replace(/\\/gu, '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
  return base.replace(/\.exe$/u, '')
}

/**
 * The hook a shell can hold, or null when it has no pre-exec point.
 *
 * `sh`, `dash`, `ksh`, `cmd` and PowerShell are deliberately absent: their
 * startup gives no reliable "about to run this line" moment, so a terminal under
 * them keeps the un-narrowed environment it always had.
 */
export function terminalEnvHookShell(shellPath: string): TerminalEnvHookShell | null {
  switch (shellName(shellPath)) {
    case 'zsh':
      return 'zsh'
    case 'bash':
      return 'bash'
    case 'fish':
      return 'fish'
    default:
      return null
  }
}

/**
 * Statements that change the shell itself rather than run a program.
 *
 * A rule names a command to run, so a line that only moves the shell around must
 * not wait on the app, and must never be handed a secret: `export PATH=…` is not
 * the user's deploy script.
 */
const SHELL_STATE_COMMAND =
  /^(?:cd|pushd|popd|export|unset|alias|unalias|set|setenv|typeset|declare|local|readonly|source|\.|exec|eval|function|trap|history|exit|logout|fg|bg|jobs|disown|suspend|shift|return|umask|ulimit|shopt|complete|compdef|hash|rehash|clear|reset|stty|bindkey|zstyle|autoload)\b/u

/** Whether a line is about the shell rather than a command a rule can name. */
export function terminalEnvHookBypass(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return true
  return SHELL_STATE_COMMAND.test(trimmed)
}

/** Join a home directory and a startup file name, always with forward slashes. */
function joinPath(directory: string, name: string): string {
  return `${directory.replace(/\/+$/u, '').replace(/\\/gu, '/')}/${name}`
}

/** Single-quote a value for zsh, bash and fish alike, which all expand alike here. */
function quote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

/** One name per line, so the hook can record what to take back afterwards. */
export function namesFileContents(names: readonly string[]): string {
  return names.length === 0 ? '' : `${names.join('\n')}\n`
}

/**
 * The sourceable snippet that exports one command's values.
 *
 * Written for the shell that asked, because fish spells an export differently.
 * No value is ever interpolated unquoted, and a quote inside a value survives.
 */
export function responseScript(
  shell: TerminalEnvHookShell,
  values: Readonly<Record<string, string>>
): string {
  const lines = Object.entries(values).map(([name, value]) =>
    shell === 'fish' ? `set -gx ${name} ${quote(value)}` : `export ${name}=${quote(value)}`
  )
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

/** The `$PWD` and command line the shell put in a request file. */
export function parseHookRequest(text: string): { pwd: string; command: string } {
  const newline = text.indexOf('\n')
  if (newline < 0) return { pwd: '', command: text.trim() }
  return {
    pwd: text.slice(0, newline).trim(),
    command: text.slice(newline + 1).replace(/\n+$/u, '')
  }
}

/** How long the shell waits for the app before running the line without values. */
const POLL_ATTEMPTS = 200
/** Gap between polls: short enough to feel instant, long enough to idle cheaply. */
const POLL_SECONDS = '0.005'

/** The hook body for zsh, which has a real pre-exec and pre-prompt hook. */
function zshHook(): string {
  return `__cio_env_hook_dir="$CIO_ENV_HOOK_DIR"
__cio_env_hook_seq=0
__cio_env_hook_names=()
__cio_env_hook_preexec() {
  local __cio_line="$1" __cio_wait=0 __cio_name __cio_seq
  [[ -n "$__cio_env_hook_dir" && -d "$__cio_env_hook_dir" ]] || return 0
  __cio_env_hook_seq=$(( __cio_env_hook_seq + 1 ))
  __cio_seq=$__cio_env_hook_seq
  print -r -- "$PWD
$__cio_line" >| "$__cio_env_hook_dir/req.$__cio_seq.tmp" 2>/dev/null || return 0
  mv -f "$__cio_env_hook_dir/req.$__cio_seq.tmp" "$__cio_env_hook_dir/req.$__cio_seq" 2>/dev/null || return 0
  while [[ ! -f "$__cio_env_hook_dir/res.$__cio_seq" && $__cio_wait -lt ${POLL_ATTEMPTS} ]]; do
    sleep ${POLL_SECONDS}
    __cio_wait=$(( __cio_wait + 1 ))
  done
  [[ -f "$__cio_env_hook_dir/res.$__cio_seq" ]] || return 0
  source "$__cio_env_hook_dir/res.$__cio_seq" 2>/dev/null
  while IFS= read -r __cio_name; do
    [[ -n "$__cio_name" ]] && __cio_env_hook_names+=("$__cio_name")
  done < "$__cio_env_hook_dir/names.$__cio_seq" 2>/dev/null
  rm -f "$__cio_env_hook_dir/res.$__cio_seq" "$__cio_env_hook_dir/names.$__cio_seq" 2>/dev/null
  return 0
}
__cio_env_hook_precmd() {
  (( \${#__cio_env_hook_names} )) || return 0
  unset "\${__cio_env_hook_names[@]}" 2>/dev/null
  __cio_env_hook_names=()
  return 0
}
typeset -ga preexec_functions precmd_functions
preexec_functions+=(__cio_env_hook_preexec)
precmd_functions+=(__cio_env_hook_precmd)
`
}

/**
 * The hook body for bash.
 *
 * bash has no pre-exec hook, so this is the smallest honest version of
 * bash-preexec: a DEBUG trap reads the whole accepted line out of history, runs
 * once per prompt (a flag tells the trap whether a line is already in flight), and
 * PROMPT_COMMAND re-arms it and takes the values back.
 */
function bashHook(): string {
  return `__cio_env_hook_dir="$CIO_ENV_HOOK_DIR"
__cio_env_hook_seq=0
__cio_env_hook_names=()
__cio_env_hook_armed=1
__cio_env_hook_running=0
__cio_env_hook_preexec() {
  [ "$__cio_env_hook_armed" = 1 ] || return 0
  [ "$__cio_env_hook_running" = 1 ] && return 0
  [ -n "$__cio_env_hook_dir" ] && [ -d "$__cio_env_hook_dir" ] || return 0
  __cio_env_hook_armed=0
  __cio_env_hook_running=1
  local __cio_line __cio_wait=0 __cio_name __cio_seq
  __cio_line=$(HISTTIMEFORMAT= builtin history 1 2>/dev/null)
  __cio_line=\${__cio_line#"\${__cio_line%%[! 0-9]*}"}
  __cio_line=\${__cio_line#"\${__cio_line%%[! ]*}"}
  if [ -n "$__cio_line" ]; then
    __cio_env_hook_seq=$(( __cio_env_hook_seq + 1 ))
    __cio_seq=$__cio_env_hook_seq
    printf '%s\\n%s' "$PWD" "$__cio_line" > "$__cio_env_hook_dir/req.$__cio_seq.tmp" 2>/dev/null
    if mv -f "$__cio_env_hook_dir/req.$__cio_seq.tmp" "$__cio_env_hook_dir/req.$__cio_seq" 2>/dev/null; then
      while [ ! -f "$__cio_env_hook_dir/res.$__cio_seq" ] && [ "$__cio_wait" -lt ${POLL_ATTEMPTS} ]; do
        sleep ${POLL_SECONDS}
        __cio_wait=$(( __cio_wait + 1 ))
      done
      if [ -f "$__cio_env_hook_dir/res.$__cio_seq" ]; then
        . "$__cio_env_hook_dir/res.$__cio_seq" 2>/dev/null
        while IFS= read -r __cio_name; do
          [ -n "$__cio_name" ] && __cio_env_hook_names+=("$__cio_name")
        done < "$__cio_env_hook_dir/names.$__cio_seq"
        rm -f "$__cio_env_hook_dir/res.$__cio_seq" "$__cio_env_hook_dir/names.$__cio_seq" 2>/dev/null
      fi
    fi
  fi
  __cio_env_hook_running=0
  return 0
}
__cio_env_hook_precmd() {
  __cio_env_hook_armed=1
  if [ "\${#__cio_env_hook_names[@]}" -gt 0 ]; then
    unset "\${__cio_env_hook_names[@]}" 2>/dev/null
    __cio_env_hook_names=()
  fi
  return 0
}
trap '__cio_env_hook_preexec' DEBUG
PROMPT_COMMAND="__cio_env_hook_precmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
`
}

/** The hook body for fish, whose own events are already pre-exec and post-exec. */
function fishHook(): string {
  return `set -g __cio_env_hook_dir "$CIO_ENV_HOOK_DIR"
set -g __cio_env_hook_seq 0
set -g __cio_env_hook_names
function __cio_env_hook_preexec --on-event fish_preexec
  set -l __cio_line $argv[1]
  test -n "$__cio_env_hook_dir" -a -d "$__cio_env_hook_dir"; or return 0
  set -g __cio_env_hook_seq (math $__cio_env_hook_seq + 1)
  set -l __cio_seq $__cio_env_hook_seq
  printf '%s\\n%s' "$PWD" "$__cio_line" > "$__cio_env_hook_dir/req.$__cio_seq.tmp" 2>/dev/null; or return 0
  mv -f "$__cio_env_hook_dir/req.$__cio_seq.tmp" "$__cio_env_hook_dir/req.$__cio_seq" 2>/dev/null; or return 0
  set -l __cio_wait 0
  while not test -f "$__cio_env_hook_dir/res.$__cio_seq"
    test $__cio_wait -lt ${POLL_ATTEMPTS}; or return 0
    sleep ${POLL_SECONDS}
    set __cio_wait (math $__cio_wait + 1)
  end
  source "$__cio_env_hook_dir/res.$__cio_seq" 2>/dev/null
  while read -l __cio_name
    test -n "$__cio_name"; and set -a -g __cio_env_hook_names $__cio_name
  end < "$__cio_env_hook_dir/names.$__cio_seq"
  rm -f "$__cio_env_hook_dir/res.$__cio_seq" "$__cio_env_hook_dir/names.$__cio_seq" 2>/dev/null
  return 0
end
function __cio_env_hook_postexec --on-event fish_postexec
  for __cio_name in $__cio_env_hook_names
    set -e -g $__cio_name 2>/dev/null
  end
  set -g __cio_env_hook_names
  return 0
end
`
}

/** The hook body for one shell, ready to be sourced or passed with `-C`. */
export function hookScript(shell: TerminalEnvHookShell): string {
  switch (shell) {
    case 'zsh':
      return zshHook()
    case 'bash':
      return bashHook()
    case 'fish':
      return fishHook()
  }
}

/** What an rc file has to source from the user's own startup, and where it lives. */
export interface TerminalEnvHookRcInput {
  /** The user's home directory, whose startup files the hook must keep loading. */
  home: string
  /** The user's own `ZDOTDIR`, when they set one. */
  userZdotdir: string
  /** Names kept out of the spawn environment, taken back by the hook per command. */
  deferred: readonly string[]
  /** The session directory the app answers through. */
  directory: string
}

/** A startup file the app writes into the session directory for zsh. */
export interface TerminalEnvHookRcFile {
  name: string
  contents: string
}

/** `unset` lines for the names no command has admitted yet. */
function unsetLines(names: readonly string[]): string {
  if (names.length === 0) return ''
  return `${names.map((name) => `unset ${name}`).join('\n')}\n`
}

/**
 * The zsh startup files for one hook session.
 *
 * zsh reads `$ZDOTDIR/.zshenv`, `.zprofile`, `.zshrc` and `.zlogin`, so pointing
 * `ZDOTDIR` at the session directory would otherwise hide every file the user
 * wrote. Each one here sources its original first, then (in `.zshrc`) installs the
 * hook, so the user's prompt, aliases and completions are untouched.
 */
export function zshRcFiles(input: TerminalEnvHookRcInput): TerminalEnvHookRcFile[] {
  const original = (name: string): string => {
    const path = quote(joinPath(input.userZdotdir, name))
    return `if [[ -f ${path} ]]; then source ${path}; fi\n`
  }
  return [
    {
      name: '.zshenv',
      contents: `# CodeInOven session startup: keeps the user's own .zshenv.\n${original('.zshenv')}`
    },
    {
      name: '.zprofile',
      contents: `# CodeInOven session startup: keeps the user's own .zprofile.\n${original('.zprofile')}`
    },
    {
      name: '.zlogin',
      contents: `# CodeInOven session startup: keeps the user's own .zlogin.\n${original('.zlogin')}`
    },
    {
      name: '.zshrc',
      contents: [
        "# CodeInOven session startup: the user's own .zshrc, then the env hook.",
        original('.zshrc'),
        hookScript('zsh'),
        // A ruled key must not survive from the user's profile: its rule decides.
        unsetLines(input.deferred)
      ].join('')
    }
  ]
}

/**
 * The bash startup file.
 *
 * bash only honours `--init-file` before its own flags, so the session is a
 * non-login interactive shell and this file loads the login profile the user
 * expects, then `.bashrc`, then the hook.
 */
export function bashRcFile(input: TerminalEnvHookRcInput): TerminalEnvHookRcFile {
  const home = input.home.replace(/\/+/gu, '/')
  const userRc = joinPath(home, '.bashrc')
  const profiles = [
    '/etc/profile',
    joinPath(home, '.bash_profile'),
    joinPath(home, '.bash_login'),
    joinPath(home, '.profile')
  ]
  return {
    name: 'bashrc',
    contents: [
      '# CodeInOven session startup: the login profile, then the env hook.\n',
      `[ -f /etc/profile ] && . /etc/profile\n`,
      `for __cio_profile in ${profiles.slice(1).map(quote).join(' ')}; do\n`,
      `  if [ -f "$__cio_profile" ]; then . "$__cio_profile"; break; fi\n`,
      `done\n`,
      `unset __cio_profile\n`,
      `if [ -f ${quote(userRc)} ]; then . ${quote(userRc)}; fi\n`,
      hookScript('bash'),
      unsetLines(input.deferred)
    ].join('')
  }
}

/**
 * The environment the shell needs to find its session directory.
 *
 * zsh reads its startup from `$ZDOTDIR`, so that is how the hook becomes part of a
 * login shell without replacing the user's own files.
 */
export function hookEnvironment(
  shell: TerminalEnvHookShell,
  directory: string
): Record<string, string> {
  const base = { [TERMINAL_ENV_HOOK_DIRECTORY]: directory }
  return shell === 'zsh' ? { ...base, ZDOTDIR: directory } : base
}
