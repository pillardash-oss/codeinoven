/**
 * The spotlight step data behind every tour.
 *
 * The getting-started tour and each content view's own tour are the same
 * presentation over different step lists, so the copy lives here, in one plain
 * module, and `OnboardingTour.svelte` only renders whichever list it is given.
 * A step names the element it points at by `data-onboarding` value: when that
 * element is not on screen the tour falls back to a centered callout, so a step
 * never breaks, it only stops pointing.
 */

/** One keyboard row rendered inside a step's callout. */
export interface SpotlightShortcut {
  label: string
  keys: string
}

export interface SpotlightStep {
  /** `data-onboarding` value of the element this step explains. */
  selector: string
  eyebrow: string
  title: string
  description: string
  /** Chords the step demonstrates, shown as key rows under the copy. */
  shortcuts?: readonly SpotlightShortcut[]
}

/** The content views that own an empty state and, with it, a tour. */
export type WorkspaceTourView = 'projects' | 'threads' | 'chats' | 'assistant'

export interface ViewTour {
  /** The view's name, as the palette entry and the step counter say it. */
  name: string
  steps: readonly SpotlightStep[]
}

/** The tour a shell view owns, or null for a view without an empty state. */
export function workspaceTourViewFor(view: string): WorkspaceTourView | null {
  if (view === 'projects-scope') return 'projects'
  return view === 'projects' || view === 'threads' || view === 'chats' || view === 'assistant'
    ? view
    : null
}

export function viewTourLabel(view: WorkspaceTourView): string {
  return `${VIEW_TOURS[view].name} tour`
}

const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC')

/** A chord as this machine writes it (`⌘N` on macOS, `Ctrl+N` elsewhere). */
export function shortcutKey(key: string): string {
  return isMac ? `⌘${key}` : `Ctrl+${key}`
}

/** A modifier chord without a letter, e.g. Enter or Shift+Enter. */
export function chordKey(key: string): string {
  return `${isMac ? '⌘' : 'Ctrl+'} ${key}`
}

const sendShortcut = chordKey('Enter')
const steerShortcut = chordKey('⇧ Enter')

/**
 * The first-run setup tour: the workspace as a whole, then a first project and
 * a first coding agent. Its steps are the middle of that sequence, between the
 * welcome screen and the setup screens.
 */
export const SETUP_SPOTLIGHT_STEPS: readonly SpotlightStep[] = [
  {
    selector: '[data-onboarding="view-switcher"]',
    eyebrow: 'View rail',
    title: 'Switch views from the left rail',
    description: `The rail down the left edge switches how the workspace is organized. Projects groups conversations by folder (${shortcutKey('1')}). Threads lists every project conversation (${shortcutKey('2')}). Scoped threads opens the scope sidebar over Projects (${shortcutKey('3')}), Scope Board opens the full-page board (${shortcutKey('4')}), Chats is for work that does not need a project (${shortcutKey('0')}), and Assistant holds routines and tasks (${shortcutKey('9')}).`
  },
  {
    selector: '[data-onboarding="project-sidebar"]',
    eyebrow: 'Left Sidebar',
    title: 'Threads and Projects',
    description:
      'The sidebar holds your projects and conversations. Pick a project, then open a thread or start a new one.'
  },
  {
    selector: '[data-onboarding="conversation"]',
    eyebrow: 'Conversation',
    title: 'Work with the agent here',
    description:
      'Messages, questions, plans, approvals, and results all stay in this main area. You can follow the work without opening a terminal.'
  },
  {
    selector: '[data-onboarding="composer"]',
    eyebrow: 'Send and steer',
    title: 'Type what you want done',
    description:
      "The composer accepts plain instructions, file attachments of all kinds. You can also dictate with the microphone, or tap it to read the agent's response. Check the sound settings for more",
    shortcuts: [
      { label: 'Send a message', keys: sendShortcut },
      { label: 'Steer a working agent now', keys: steerShortcut }
    ]
  },
  {
    selector: '[data-onboarding="notifications"]',
    eyebrow: 'Context and alerts',
    title: 'Tools open on the right',
    description:
      'Notifications, files, Git changes, terminals, sources, and memory open in the right sidebar. The bell collects completed work and anything that needs you.'
  }
]

/**
 * Each view's own tour, pointed at the anchors that view actually paints while
 * its empty state is on screen: the rail, the view's header actions, the empty
 * state's own actions, the chat composer, and the notification bell. A view
 * whose sidebar content is what makes the sidebar appear never points at the
 * sidebar itself, because the tour runs exactly when that sidebar is hidden.
 */
export const VIEW_TOURS: Record<WorkspaceTourView, ViewTour> = {
  projects: {
    name: 'Projects',
    steps: [
      {
        selector: '[data-onboarding="view-switcher"]',
        eyebrow: 'View rail',
        title: 'Projects groups work by folder',
        description:
          'A project is a folder on this computer, and every conversation about it lives inside its row. The rail switches to Threads, Chats and the Assistant from here.'
      },
      {
        selector: '[data-onboarding="view-actions"]',
        eyebrow: 'Header actions',
        title: 'The view runs from the header',
        description:
          'These actions belong to the view you are in: search every project conversation, or add another project without leaving the view.'
      },
      {
        selector: '[data-onboarding="empty-state-actions"]',
        eyebrow: 'Start here',
        title: 'Add your first project',
        description:
          'Pick a folder already on this computer, or clone a repository. CodeInOven opens the project’s first thread as soon as it is added.'
      },
      {
        selector: '[data-onboarding="notifications"]',
        eyebrow: 'Context and alerts',
        title: 'Everything that needs you lands here',
        description:
          'Finished threads, spec approvals and parked questions collect on the bell. Every entry opens the conversation it came from.'
      }
    ]
  },
  threads: {
    name: 'Threads',
    steps: [
      {
        selector: '[data-onboarding="view-switcher"]',
        eyebrow: 'View rail',
        title: 'One timeline for every conversation',
        description:
          'Threads lists the conversations of all your projects together, most recent activity first, so you never have to remember which folder a conversation belonged to.'
      },
      {
        selector: '[data-onboarding="view-actions"]',
        eyebrow: 'Header actions',
        title: 'Search, filter, and start threads',
        description:
          'Search every conversation, narrow the timeline to the projects you care about, and start a thread in the active project.'
      },
      {
        selector: '[data-onboarding="empty-state-actions"]',
        eyebrow: 'Start here',
        title: 'A conversation needs a project',
        description:
          'Add a folder as a project and its conversations appear in this timeline as you work. A chat needs no project, so it lives in Chats instead.'
      },
      {
        selector: '[data-onboarding="notifications"]',
        eyebrow: 'Context and alerts',
        title: 'Follow work without watching it',
        description:
          'The bell collects completed threads and anything waiting on you, so you can leave a long run and come back to exactly what changed.'
      }
    ]
  },
  chats: {
    name: 'Chats',
    steps: [
      {
        selector: '[data-onboarding="view-switcher"]',
        eyebrow: 'View rail',
        title: 'Chats need no project',
        description:
          'A chat is a real thread with its own history, model and attachments, but it belongs to no folder. Everything you ask for here stays out of your project threads.'
      },
      {
        selector: '[data-onboarding="composer"]',
        eyebrow: 'Composer',
        title: 'Type what you want done',
        description:
          'Send plain instructions with any file attached. The chat becomes a thread in the sidebar the moment it holds something, so a draft is never lost.',
        shortcuts: [{ label: 'Send a message', keys: sendShortcut }]
      },
      {
        selector: '[data-onboarding="view-actions"]',
        eyebrow: 'Header actions',
        title: 'Find any chat',
        description:
          'Search every chat, or start another one, from the actions beside the view name. Each chat keeps its own place in the list.'
      },
      {
        selector: '[data-onboarding="notifications"]',
        eyebrow: 'Context and alerts',
        title: 'Answers come back to you',
        description:
          'A finished answer raises its own entry on the bell, so a long reply never passes unnoticed while you work on something else.'
      }
    ]
  },
  assistant: {
    name: 'Assistant',
    steps: [
      {
        selector: '[data-onboarding="view-switcher"]',
        eyebrow: 'View rail',
        title: 'The Assistant is its own view',
        description: `Routines and tasks live here, apart from your project threads, so scheduled work never mixes with the work you are doing by hand. Open it from the rail with ${shortcutKey('9')}.`
      },
      {
        selector: '[data-onboarding="view-actions"]',
        eyebrow: 'Header actions',
        title: 'Routines and tasks start here',
        description:
          'A routine owns a repeating job and the how-to that describes it. A task is a single piece of work. Search runs, create either one, and start a task with the same actions.',
        shortcuts: [
          { label: 'New task', keys: shortcutKey('N') },
          { label: 'New routine', keys: isMac ? '⌘⇧N' : 'Ctrl+Shift+N' }
        ]
      },
      {
        selector: '[data-onboarding="empty-state-actions"]',
        eyebrow: 'Start here',
        title: 'Begin with a routine',
        description:
          'A new routine opens a Getting started thread, where the agent interviews you until the how-to, the schedule and the connections it needs are agreed.'
      },
      {
        selector: '[data-onboarding="notifications"]',
        eyebrow: 'Context and alerts',
        title: 'Runs report back',
        description:
          'Every run lands in the sidebar under its routine and raises its own notice naming that routine, so a scheduled job never finishes silently.'
      }
    ]
  }
}
