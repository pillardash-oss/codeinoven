/** User-owned remote npm installs stay separate from the system Node installation. */
export const OVEN_NPM_PREFIX = '.config/pillardash/codeinoven-oven/harnesses/npm'
export const OVEN_HARNESS_PATH = `export PATH="$HOME/${OVEN_NPM_PREFIX}/bin:$PATH";`
export const OVEN_NPM_ENV = `npm_config_prefix="$HOME/${OVEN_NPM_PREFIX}"`
