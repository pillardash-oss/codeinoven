import {
  designAssignmentCatalogue,
  designAssignmentOutput,
  designAssignmentOutputWork,
  resolveDesignAssignment,
  usableDesignAssignments
} from '../../lib/design-assignments'
import type { EffectiveExperts } from '../../lib/experts'
import { requireLocalProject } from '../../lib/project-artifacts'
import { requiredString } from '../utilities/utility-orchestration/utility-input'
import type { AgentModelSelection, DesignAssignmentOutput, DesignConfig } from '../../lib/types'
import type { Database } from '../database/database'
import type { DesignCapabilityExecutor } from '../utilities/utility-orchestration-service'

/**
 * Run the app-owned design capability's `delegate` operation.
 *
 * Delegation is how a design session reaches a model the user assigned to a
 * named piece of work (the copy, an SEO pass, a storyboard, the images).
 * The app's whole job here is to honour that assignment and nothing else:
 *
 * - it resolves the assignment from the live config on every call, so a settings
 *   change applies to the next call rather than the next app run;
 * - it refuses when nothing is assigned, naming the work the user has to assign
 *   a model to, because picking a model on their behalf is exactly the behaviour
 *   the assignment exists to prevent;
 * - it hands the assigned model a prompt and returns its answer. The model sees
 *   no part of the conversation, so the caller has to carry everything.
 */

/** Ceiling on one delegated prompt, so a hand-written call cannot inflate a process argument. */
const MAX_DELEGATE_PROMPT_LENGTH = 20_000

/** Ceiling on the assignment name an agent may type. */
const MAX_ASSIGNMENT_NAME_LENGTH = 80

export interface DesignAssignmentRunRequest {
  /** The model the user assigned. Never substituted, never reordered. */
  selection: AgentModelSelection
  /** Human label of the assignment, used to title the disposable model session. */
  label: string
  /** The complete prompt, already carrying the assignment's own guidance. */
  prompt: string
  projectId: string
  threadId: string
  /** Resolved working directory for the assigned harness. */
  projectPath: string
}

export interface DesignAssignmentRunResult {
  /** The assigned model's answer. */
  text: string
  harnessId: string
  providerId: string
  modelId: string
}

/**
 * Runs the prompt on one user-assigned model. Supplied by the chat engine, which
 * owns drivers, accounts and project path resolution.
 */
export type DesignAssignmentRunner = (
  request: DesignAssignmentRunRequest
) => Promise<DesignAssignmentRunResult>

export interface DesignAssignmentExecutorOptions {
  database: Database
  /**
   * The experts this thread's session may delegate to, and why it may use none.
   * Read per call, so a re-assignment or a mute applies to the next delegation
   * rather than the next app run.
   */
  experts: (context: { projectId: string; threadId: string }) => Promise<EffectiveExperts>
  run: DesignAssignmentRunner
}

export function createDesignAssignmentExecutor(
  options: DesignAssignmentExecutorOptions
): DesignCapabilityExecutor {
  return async (operation, input, context) => {
    if (operation !== 'delegate') {
      throw new Error(
        `The design delegation exposes one operation, "delegate", and no operation named "${operation}".`
      )
    }
    const requested = requiredString(input['assignment'], 'assignment', MAX_ASSIGNMENT_NAME_LENGTH)
    const prompt = requiredString(input['prompt'], 'prompt', MAX_DELEGATE_PROMPT_LENGTH)
    // The thread's own answer, not the global config: a session the user muted
    // has no experts at all, so the refusal below says that rather than claiming
    // the user never staffed anyone.
    const effective = await options.experts(context)
    const config: DesignConfig = { assignments: effective.assignments }
    const assignment = resolveDesignAssignment(config, requested)
    if (!assignment) {
      const catalogue = designAssignmentCatalogue(config)
      throw new Error(
        catalogue.length === 0
          ? refusalForNoExpert(effective.availability)
          : `There is no expert named "${requested}". The user assigned ${catalogue}; delegate one of those, or ask them to add the work you need in Settings, Design.`
      )
    }
    const project = requireLocalProject(options.database, context.projectId)
    const output = designAssignmentOutput(assignment)
    // Two assignments with one output are the user's own alternatives for that
    // job, so the one they named is tried first and the rest cover it in their
    // order. This is not the app substituting a model: every candidate here is a
    // model the user assigned to exactly this output.
    const candidates = [
      assignment,
      ...usableDesignAssignments(config).filter(
        (entry) => entry.id !== assignment.id && designAssignmentOutput(entry) === output
      )
    ]
    const failures: string[] = []
    for (const [index, candidate] of candidates.entries()) {
      const guidance = candidate.instructions?.trim()
      try {
        const result = await options.run({
          selection: candidate.selection,
          label: candidate.label,
          prompt: guidance ? `${guidance}\n\n${prompt}` : prompt,
          projectId: context.projectId,
          threadId: context.threadId,
          projectPath: project.path
        })
        return {
          assignment: candidate.id,
          label: candidate.label,
          produces: output,
          model: `${result.harnessId}/${result.providerId}/${result.modelId}`,
          output: result.text,
          ...(index === 0 ? {} : { fell_back_from: failures }),
          note: `${noteFor(output, index > 0)} It did not see this conversation, so it knew only what the prompt carried.`
        }
      } catch (error) {
        failures.push(`${candidate.label} (${candidate.id}): ${errorMessage(error)}`)
      }
    }
    throw new Error(
      candidates.length === 1
        ? `The model assigned to "${assignment.label}" did not answer. ${failures[0] ?? ''}`.trim()
        : `Every model the user assigned for ${designAssignmentOutputWork(output)} failed. ${failures.join('; ')}`
    )
  }
}

/**
 * Why nothing was delegated, in the terms of the reason.
 *
 * A mute and an empty settings page are different answers, and an agent told the
 * wrong one does the wrong thing: told nothing is assigned it asks the user to
 * assign a model, which they already did and then turned off for this thread.
 */
function refusalForNoExpert(availability: EffectiveExperts['availability']): string {
  if (availability === 'muted') {
    return 'The user turned the experts off for this thread, so nothing is delegated here. Do the work with your own tools when you can, and where it genuinely needs a model, tell the user plainly which work needs one and that they can turn the experts back on for this thread from the design coordinator. Never choose a model yourself.'
  }
  return 'No expert is assigned yet: the user has not put a model on any of the work a design or a composition needs. Do the work with your own tools when you can, and when the work needs something you cannot produce, tell the user plainly which work needs a model and that they assign it in Settings, Design. Never choose a model yourself.'
}

/** One line on what came back, which differs for copywriting and for the other crafts. */
function noteFor(output: DesignAssignmentOutput, usedFallback: boolean): string {
  const standing = usedFallback
    ? 'The first model the user assigned to this work did not answer, so this one did.'
    : 'Produced by the model the user assigned to this work.'
  return output === 'text'
    ? standing
    : `${standing} It was chosen for ${designAssignmentOutputWork(output)}, and this lane answers with text only, so the reply above is not the asset: produce it with a generation capability and save it with save-media.`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
