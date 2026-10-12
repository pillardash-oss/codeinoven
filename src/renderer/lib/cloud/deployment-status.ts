import type { CloudDeploymentStatus } from '$shared/types'
import type { StatusTone } from '../components/ui/status-tone'

/**
 * Presentation vocabulary for the two independent states a monitored container
 * carries, kept in one place so the list rows, the status strip, and the detail
 * header never drift apart:
 *
 * - the container's **runtime** state (is it up?), from `runtimeStatus`
 * - its **last deployment** outcome, from `status`
 *
 * The whole point of splitting these is that a running container whose last
 * deployment failed must never read as the container (or the deployed site)
 * being offline, so their labels are deliberately distinct.
 */

/** Tone for the container's runtime state. */
export function runtimeStatusTone(status: CloudDeploymentStatus | undefined): StatusTone {
  if (status === 'success') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'building') return 'warning'
  return 'neutral'
}

/** Label for the container's runtime state. */
export function runtimeStatusLabel(status: CloudDeploymentStatus | undefined): string {
  if (status === 'success') return 'Running'
  if (status === 'failed') return 'Stopped'
  if (status === 'building') return 'Starting'
  return 'Unknown'
}

/** Tone for the last deployment outcome. */
export function deploymentStatusTone(status: CloudDeploymentStatus | undefined): StatusTone {
  if (status === 'success') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'building') return 'warning'
  return 'neutral'
}

/** Label for the last deployment outcome. */
export function deploymentStatusLabel(status: CloudDeploymentStatus | undefined): string {
  if (status === 'success') return 'Deployed'
  if (status === 'failed') return 'Deploy failed'
  if (status === 'building') return 'Deploying'
  return 'No deployment'
}
