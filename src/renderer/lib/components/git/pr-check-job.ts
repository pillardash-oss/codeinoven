import type { GitHubDeploymentJob, GitHubWorkflowRunDetail, PullRequestCheck } from '$shared/types'

/**
 * The job behind a check, inside the run that owns it.
 *
 * Actions names the job in the check's `details_url`, which is exact even for one
 * leg of a matrix run; when the provider only gives the run, the job is matched by
 * name so the wrong leg's log is never read. Pure, because the two callers fetch
 * the run detail on their own terms: the checks list reads it only when the check
 * does not already name a job, and the assignment always reads it for the job's
 * metadata.
 */
export function jobForCheck(
  run: GitHubWorkflowRunDetail | null,
  check: PullRequestCheck
): GitHubDeploymentJob | null {
  if (!run) return null
  const byId = check.jobId === null ? undefined : run.jobs.find((job) => job.id === check.jobId)
  return byId ?? run.jobs.find((job) => job.name === check.name) ?? null
}
