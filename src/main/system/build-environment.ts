import { BUILD_ENVIRONMENT_ARG_PREFIX, type BuildEnvironment } from '../../lib/build-environment'
import { isBackgroundRegistrationDisabled } from '../../lib/utils'
import { isShippedBuild } from '../bootstrap/app-resources'

/**
 * Which build this process is, resolved once for every window.
 *
 * A probe is checked first: it is a development launch that opted out of
 * background registration (see `scripts/dev-probe.ts`), so it would otherwise
 * resolve to `dev` and the two would be indistinguishable in the header.
 */
export function resolveBuildEnvironment(): BuildEnvironment {
  if (isBackgroundRegistrationDisabled()) return 'probe'
  if (isShippedBuild() || process.env['NODE_ENV'] === 'production') return 'production'
  return 'dev'
}

let cachedArg: string | null = null

/** The `additionalArguments` payload to pass into each BrowserWindow. */
export function getBuildEnvironmentArg(): string {
  cachedArg ??= `${BUILD_ENVIRONMENT_ARG_PREFIX}${resolveBuildEnvironment()}`
  return cachedArg
}
