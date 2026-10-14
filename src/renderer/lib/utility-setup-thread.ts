import { ASSISTANT_SPACE_ID, type Project, type Routine, type Thread } from '$shared/types'
import { routinePrimaryModel, settingsWithRoutineModel } from '$shared/routine-agents'
import { invoke } from '$lib/ipc.svelte'
import { composerBuiltInTag } from '$lib/components/chats/composer-mentions'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { threadSettings } from '$lib/stores/thread-settings.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import {
  settingsForNewAssistantTask,
  settingsForNewThread,
  withProjectOven
} from '$lib/thread-settings-inheritance'

/**
 * Handing a utility setup to an agent in a thread of its own.
 *
 * Setup used to run as a disposable session behind the capability modal: the
 * user picked a model, pressed Run, and waited on a spinner until the app
 * reported what had been installed. Nothing was visible, nothing could be
 * steered, a credential the agent needed had no card to arrive in, and the work
 * left no conversation to audit afterwards.
 *
 * Every assisted entry now opens a real thread instead, with the setup request
 * already in its composer and the caret at the end, so the user finishes the
 * sentence, presses send, and watches the agent work in a conversation they can
 * steer like any other.
 */

/** The tag that grants the setup contract for the turn that carries it. */
const UTILITY_SETUP_TAG = composerBuiltInTag('cio-utility').token

/**
 * What a setup request with nothing specified yet asks for. It stays open ended
 * on purpose: the user completes it with the capability they want, wherever it
 * comes from.
 */
export const UTILITY_SETUP_REQUEST_START = 'help me setup a utility for '

/**
 * What a setup thread is called until the first turn names it. Title generation
 * replaces a thread on the default title source, so this is a readable
 * placeholder rather than a name that sticks.
 */
export const UTILITY_SETUP_THREAD_TITLE = 'Set up a utility'

/**
 * The composer draft a setup thread opens with.
 *
 * A request the authoring agent recorded for a connection it could not install
 * itself becomes the sentence after the tag, so the user only has to read it and
 * press send. Without one, the draft ends mid-sentence with a trailing space,
 * because the user is the one who knows what they want set up.
 */
export function utilitySetupDraft(request?: string | null): string {
  const recorded = request?.trim() ?? ''
  return recorded
    ? `${UTILITY_SETUP_TAG} ${recorded}`
    : `${UTILITY_SETUP_TAG} ${UTILITY_SETUP_REQUEST_START}`
}

/**
 * The project a setup thread belongs to: the one the user was last on.
 *
 * The entry points live outside any thread (the Utilities settings page, a
 * routine's panel), so the project has to be remembered state rather than
 * anything on screen. The open thread is the most specific answer, the
 * workspace's active project covers a project opened without a thread, the
 * recovery snapshot carries the choice across a restart, and the most recent
 * thread covers a first run after cleanup. Only projects the caller passed in
 * are eligible, which is what keeps a setup thread out of the hidden containers
 * (chats, the assistant space, the global browser).
 */
export function resolveUtilitySetupProject(
  projects: readonly Project[],
  threads: readonly Thread[]
): Project | null {
  const byId = new Map(projects.map((project) => [project.id, project] as const))
  const remembered = [
    workspaceState.selectedThread?.projectId,
    workspaceState.activeProject?.id,
    rendererRecovery.selectedProjectId
  ]
  for (const projectId of remembered) {
    const project = projectId ? byId.get(projectId) : undefined
    if (project) return project
  }
  const mostRecent = [...threads].sort((left, right) => right.lastActivity - left.lastActivity)[0]
  return mostRecent ? (byId.get(mostRecent.projectId) ?? null) : null
}

/**
 * Create a setup thread in a project the user was working in.
 *
 * Only a thread in this project is a sibling to inherit from: a thread from
 * another project would carry a model, a permission tier and an Oven that
 * belong to work the user is not doing here.
 */
export async function openProjectUtilitySetupThread(
  project: Project,
  request?: string | null
): Promise<Thread> {
  const selected = workspaceState.selectedThread
  const sibling = selected && selected.projectId === project.id ? selected : null
  const thread = await createSetupThread({
    project,
    title: UTILITY_SETUP_THREAD_TITLE,
    settings: withProjectOven(
      settingsForNewThread(sibling, threadSettings.lastUsed),
      project,
      sibling !== null
    ),
    scopeBucketId: workspaceState.activeScopeBucketIdFor(project.id)
  })
  openSeededSetupThread(thread, project, request)
  return thread
}

/**
 * Create a routine's own setup thread for one of its connections.
 *
 * The thread belongs to the routine rather than to whichever project the user
 * happens to be in. A connection is the routine's, so its setup runs on the
 * routine's primary model, sits beside the routine's other tasks where the
 * routine's panel reports on it, and starts off the routine's clock: a thread
 * the user opened to configure something must never become a quiet recurring
 * job of the routine.
 */
export async function openRoutineUtilitySetupThread(input: {
  project: Project
  routine: Routine
  label: string
  request?: string | null
}): Promise<Thread> {
  const focused =
    workspaceState.selectedThread?.projectId === input.project.id
      ? workspaceState.selectedThread
      : null
  const inherited = settingsForNewAssistantTask(
    input.project.id === ASSISTANT_SPACE_ID ? focused : null,
    threadSettings.lastUsed
  )
  const primary = routinePrimaryModel(input.routine.agents)
  const label = input.label.trim()
  const thread = await createSetupThread({
    project: input.project,
    title: label ? `Set up ${label}` : UTILITY_SETUP_THREAD_TITLE,
    settings: primary ? settingsWithRoutineModel(inherited, primary) : inherited,
    routineId: input.routine.id
  })
  openSeededSetupThread(thread, input.project, input.request)
  return thread
}

/** One `thread:create` for both contexts: the only differences are the fields. */
async function createSetupThread(input: {
  project: Project
  title: string
  settings: ReturnType<typeof settingsForNewThread>
  routineId?: string
  scopeBucketId?: string
}): Promise<Thread> {
  return invoke('thread:create', {
    projectId: input.project.id,
    providerId: input.settings.harnessId,
    title: input.title,
    workingDirectory: input.project.path,
    settings: input.settings,
    ...(input.routineId ? { routineId: input.routineId, scheduled: false } : {}),
    ...(input.scopeBucketId ? { scopeBucketId: input.scopeBucketId } : {})
  })
}

/**
 * Seed the request and open the thread ready to type into.
 *
 * The seed lands in the draft store before the conversation mounts, because the
 * composer reads its draft once at construction. Opening in the owning view is
 * what puts the caret at the end: it remounts the composer, whose autofocus
 * focuses the editor and places the caret after the seeded text.
 */
function openSeededSetupThread(thread: Thread, project: Project, request?: string | null): void {
  rendererRecovery.setDraft(thread.projectId, thread.id, utilitySetupDraft(request))
  workspaceState.openThreadInOwningView(thread, project)
}
