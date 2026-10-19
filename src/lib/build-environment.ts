/**
 * Build environment   the single answer to "which build is this?", shared by the
 * main process, the preload bridge, and the renderer.
 *
 * A shipped launch is `production` and shows no marker. A launch out of a
 * checkout is `dev`, and a probe (a second instance started with its own data
 * root and background registration off) is `probe`. Both deserve a visible
 * marker because they run the same source and the only thing that separates them
 * is where their data lives, which is exactly the mistake worth preventing.
 */

export type BuildEnvironment = 'production' | 'dev' | 'probe'

/** Command-line flag carrying the resolved environment into the renderer process. */
export const BUILD_ENVIRONMENT_ARG_PREFIX = '--cio-build-environment='

/**
 * The environment assumed when the flag is missing, which only happens on a
 * partial build. It resolves to no marker on purpose: a shipped app must never
 * be labelled a development build because a flag went missing.
 */
export const DEFAULT_BUILD_ENVIRONMENT: BuildEnvironment = 'production'

/** The short marker a build shows in the app header; null means show nothing. */
export function buildEnvironmentLabel(
  environment: BuildEnvironment = DEFAULT_BUILD_ENVIRONMENT
): string | null {
  switch (environment) {
    case 'production':
      return null
    case 'dev':
      return 'dev'
    case 'probe':
      return 'probe'
  }
}

export function parseBuildEnvironment(value: string | undefined): BuildEnvironment | null {
  switch (value) {
    case 'production':
    case 'dev':
    case 'probe':
      return value
    default:
      return null
  }
}
