import type { OvenPrepareStep } from '../../lib/types'

/**
 * Planning and running the work a remote Oven needs before a turn can stream.
 *
 * The three pieces are independent: installing the harness, installing git, and
 * cloning the checkout touch different things on the Oven and none of them reads
 * what another one writes. They therefore run at the same time, and the runner
 * below is built around that: a sequential loop would make a user wait for three
 * timeouts in series whenever an Oven is slow or unreachable, and it would hide
 * the fact that only one of them is stuck.
 *
 * The planner stays pure so the decision ("does this Oven need anything?") can be
 * unit-tested without an SSH connection, and the runner stays free of I/O so the
 * actions are supplied by the caller that owns the Oven connection.
 */

/** The facts the plan depends on, read from the Oven without mutating it. */
export interface OvenPrepareFacts {
  harnessInstalled: boolean
  gitInstalled: boolean
  checkoutPresent: boolean
  /** How the Oven is named in the UI, e.g. "hetzner-1". */
  ovenLabel: string
  /** The harness the turn will run, e.g. "Claude Code". */
  harnessName: string
  /** The project whose checkout has to exist, e.g. "codeinoven". */
  projectName: string
}

/** One preparation action, keyed by the step it drives. */
export type OvenPrepareActions = Record<OvenPrepareStep['id'], () => Promise<void>>

/** The steps that actually have work to do, in id order, all still waiting. */
export function planOvenPrepare(facts: OvenPrepareFacts): OvenPrepareStep[] {
  const steps: OvenPrepareStep[] = []
  if (!facts.harnessInstalled)
    steps.push({
      id: 'harness',
      label: `Install ${facts.harnessName} on ${facts.ovenLabel}`,
      status: 'waiting'
    })
  if (!facts.gitInstalled)
    steps.push({ id: 'git', label: `Install git on ${facts.ovenLabel}`, status: 'waiting' })
  if (!facts.checkoutPresent)
    steps.push({
      id: 'checkout',
      label: `Clone ${facts.projectName} onto ${facts.ovenLabel}`,
      status: 'waiting'
    })
  return steps
}

/** One action that did not finish, reported instead of thrown. */
export interface OvenPrepareFailure {
  id: OvenPrepareStep['id']
  message: string
}

/** The steps as they ended, plus everything that failed. */
export interface OvenPrepareOutcome {
  steps: OvenPrepareStep[]
  failures: OvenPrepareFailure[]
}

export interface OvenPrepareInput {
  /** The plan from `planOvenPrepare`; only these steps are started. */
  steps: OvenPrepareStep[]
  actions: OvenPrepareActions
  /** Receives an immutable snapshot after every transition. */
  publish: (steps: OvenPrepareStep[]) => void
  /** Clock used for `startedAt`/`endedAt`; tests pin it. */
  now?: () => number
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Start every planned action at once and report each one as it settles.
 *
 * Nothing is cancelled when a step fails: a failed harness install says nothing
 * about the clone, and the git install may well be the fix for the failure. The
 * outcome carries the failures rather than throwing, so the caller can name each
 * broken step in its own error and keep the rest of the work that succeeded.
 */
export async function runOvenPrepare(input: OvenPrepareInput): Promise<OvenPrepareOutcome> {
  const now = input.now ?? Date.now
  const current = input.steps.map((step): OvenPrepareStep => ({ ...step }))
  const publish = (): void => input.publish(current.map((step) => ({ ...step })))
  const failures: OvenPrepareFailure[] = []

  const started = current.map(async (step, index): Promise<void> => {
    current[index] = { ...current[index], status: 'running', startedAt: now() }
    publish()
    try {
      await input.actions[step.id]()
      current[index] = { ...current[index], status: 'done', endedAt: now() }
    } catch (error) {
      const message = messageOf(error)
      current[index] = { ...current[index], status: 'failed', detail: message, endedAt: now() }
      failures.push({ id: step.id, message })
    }
    publish()
  })
  await Promise.all(started)

  return {
    steps: current.map((step) => ({ ...step })),
    failures: current
      .map((step) => failures.find((failure) => failure.id === step.id))
      .filter((failure): failure is OvenPrepareFailure => failure !== undefined)
  }
}
