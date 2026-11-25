/**
 * Which log the cloud deployment detail view currently has open.
 *
 * A diagnosis must attach the same log the reader is looking at: the container's
 * latest build, one older deployment's build, or one compose service's runtime
 * output are three different payloads.
 */
export interface RemediationLogTarget {
  /** The deployment whose build log is open; null reads the container's latest. */
  deploymentId: string | null
  /** One of the container's compose service ids when a runtime log is open. */
  serviceName: string | null
}
