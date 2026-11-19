import { OVEN_DATA_DIRECTORY } from './remote/oven-root-paths'

/** User-owned remote npm installs stay separate from the system Node installation. */
export const OVEN_NPM_PREFIX = `${OVEN_DATA_DIRECTORY}/harnesses/npm`

/**
 * The directories that hold a Node runtime a non-interactive SSH shell cannot see.
 *
 * A version manager installs Node under the user's home and adds it to PATH from
 * a login shell's startup files. An SSH exec channel is not a login shell, so an
 * Oven whose Node arrived through nvm, volta, asdf, mise, nodenv, or a Homebrew
 * install on Apple silicon reports "node was not found" even though an
 * interactive session on that machine has it.
 *
 * They are listed in reverse priority because each is prepended in turn: the
 * newest nvm runtime ends up first, then the other managers, then the system
 * locations a login shell would also have had.
 */
const VERSION_MANAGED_PATH = [
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '"$HOME"/.local/bin',
  '"$HOME"/.local/share/mise/shims',
  '"$HOME"/.asdf/shims',
  '"$HOME"/.volta/bin',
  '"$HOME"/.nvm/versions/node/*/bin'
]

/**
 * PATH for a remote POSIX command: the managed npm prefix first, then any Node a
 * version manager installed, then whatever the SSH session already had.
 *
 * The loop guards each test with `if` on purpose: command builders prepend this
 * text to scripts that run under `set -e`, where a bare `[ -d missing ] && ...`
 * would end the command.
 */
export const OVEN_HARNESS_PATH =
  `for d in ${VERSION_MANAGED_PATH.join(' ')}; ` +
  `do if [ -d "$d" ]; then PATH="$d:$PATH"; fi; done; ` +
  `export PATH="$HOME/${OVEN_NPM_PREFIX}/bin:$PATH";`

export const OVEN_NPM_ENV = `npm_config_prefix="$HOME/${OVEN_NPM_PREFIX}"`
