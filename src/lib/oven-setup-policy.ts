import type { Oven } from './ovens'

/** Full setup and package changes are only available to SSH-connected ovens. */
export function remoteOvensForSetup(ovens: readonly Oven[]): Oven[] {
  return ovens.filter((oven) => oven.kind === 'ssh')
}
