/**
 * The view guides: one guided walk per content view, pointed at the app itself.
 *
 * A guide never covers what it is talking about. Its words live in the dock that
 * sits beside the app, and the only thing it draws inside the app is a marker on
 * the element the current stop is about. So a stop names its element by
 * `data-guide` value, and when that element is not on screen the stop keeps its
 * words and drops its marker rather than pointing at nothing.
 *
 * Which guide is allowed to run is a property of the view, not of the click that
 * started it: `workspaceTourViewFor` is the single answer to "which view owns a
 * guide", and the running guide ends the moment the user leaves that view.
 *
 * A guide is also not only a description. A stop may carry an action, and the
 * first-run sequence uses them: adding the project, opening setup, putting the
 * caret in the composer. The app performs the action, because only the app knows
 * how; the guide's job is to say what the next step is and get out of the way.
 */

import type { SettingsSection } from '$lib/stores/renderer-recovery'

/**
 * The dock's width, in rem. The dock draws itself at this width and the marker
 * reads the same number to find the edge its rule lands on, because a guide that
 * measured the dock would stop drawing the moment the dock's own rendering is
 * throttled or delayed.
 */
export const GUIDE_DOCK_WIDTH_REM = 21.5

/** The content views that own an empty state and, with it, a guided walk. */
export type WorkspaceTourView = 'projects' | 'threads' | 'chats' | 'assistant'

/**
 * The guide a shell view owns, or null for a view without an empty state.
 * Scope is the same view as Projects, so it reads the same guide.
 */
export function workspaceTourViewFor(view: string): WorkspaceTourView | null {
  if (view === 'projects-scope') return 'projects'
  return view === 'projects' || view === 'threads' || view === 'chats' || view === 'assistant'
    ? view
    : null
}

/**
 * How the marker is drawn on the element a stop is about.
 *
 * - `control` one control: a frame with a square on each corner.
 * - `region` a block of the app: edge rails with no top or bottom rule.
 * - `edge` the rail itself: a bracket standing off the window's left edge.
 */
export type GuideShape = 'control' | 'region' | 'edge'

/**
 * The block under the copy, which is where each view teaches what it alone has.
 *
 * - `locator` where the lit element lives, from the rail inward.
 * - `anatomy` the composer drawn as the four decisions it holds.
 */
export type GuideTreatment = 'locator' | 'anatomy'

/** One key row: a keymap action, so a rebind shows up in the guide. */
export interface GuideKey {
  /** Keymap action id, resolved to the user's live chord. */
  action: string
  label: string
}

/**
 * What a stop's own button does, in the app's terms. The guide names the step;
 * the app performs it, because only the app knows how to add a project, open a
 * settings page or put the caret in the composer.
 */
export type GuideActionKind =
  | { kind: 'add-project' }
  | { kind: 'focus-composer' }
  | { kind: 'open-settings'; section: SettingsSection }

export interface GuideAction {
  /** Button label. A verb, short enough for the dock's footer. */
  label: string
  run: GuideActionKind
  /**
   * True when the action hands the user to another view. The guide then waits,
   * with no dock and no marker, until they come back to the view it belongs to,
   * instead of pointing at a view they have left.
   */
  leavesTheView?: boolean
}

/** The composer's four decisions, in the order the composer itself shows them. */
export const COMPOSER_DECISIONS: readonly { position: string; name: string }[] = [
  { position: '1', name: 'Chat options' },
  { position: '2', name: 'Attach' },
  { position: '3', name: 'Permission level' },
  { position: '4', name: 'Model and thinking' }
]

export interface GuideStop {
  /** `data-guide` value of the element this stop is about. */
  anchor: string
  shape: GuideShape
  /** Gold micro-label above the title. */
  eyebrow: string
  title: string
  description: string
  /** Where the lit element sits, from the rail inward. */
  path: readonly string[]
  /** Short ledger tag, drawn on the dock's top rule. */
  tag: string
  treatment: GuideTreatment
  keys?: readonly GuideKey[]
  /** The step this stop asks the user to take, when it asks for one. */
  action?: GuideAction
}

export interface ViewGuide {
  /** The guide's name, as the dock's ledger line and the palette write it. */
  name: string
  /** The view's name on its own, for the palette entry. */
  viewName: string
  stops: readonly GuideStop[]
}

const RAIL_KEYS: readonly GuideKey[] = [
  { action: 'nav-projects', label: 'Project' },
  { action: 'nav-threads', label: 'Thread' },
  { action: 'nav-chats', label: 'Chat' },
  { action: 'nav-assistant', label: 'Assistant' }
]

const CHAT_SEND_KEYS: readonly GuideKey[] = [
  { action: 'chat-send', label: 'Send a message' },
  { action: 'chat-steer', label: 'Queue, then steer it later' }
]

/**
 * Every guide, in the order each view teaches itself. The Project guide is the
 * first-run sequence rather than a description of the view: it adds the project,
 * opens setup, and puts the caret in the composer, because a tour that only
 * talks has not onboarded anybody. The other views orient a user who already has
 * work and only need to say what belongs where.
 */
export const VIEW_GUIDES: Record<WorkspaceTourView, ViewGuide> = {
  projects: {
    name: 'Project guide',
    viewName: 'Projects',
    stops: [
      {
        anchor: 'view-switcher',
        shape: 'edge',
        eyebrow: 'Where you are',
        title: 'The rail switches the whole workspace',
        description:
          'Seven views, one chord each. A gold square marks the one you are in, and nothing else on the rail is gold.',
        path: ['Rail'],
        tag: 'start',
        treatment: 'locator',
        keys: RAIL_KEYS
      },
      {
        anchor: 'view-actions',
        shape: 'region',
        eyebrow: "This view's actions",
        title: 'The header runs the view you are in',
        description:
          'Search every thread in the project, or bring another project in. Switch views and this slot switches with you.',
        path: ['Header', 'View actions'],
        tag: 'orientation',
        treatment: 'locator'
      },
      {
        anchor: 'empty-state-actions',
        shape: 'region',
        eyebrow: 'Start here',
        title: 'One project is one folder',
        description:
          'This list is the whole way in, and it is the same list on an empty day. A project is a folder on this computer, or a clone over Git, and its first thread opens as soon as it is added.',
        path: ['Body', 'Start list'],
        tag: 'first action',
        treatment: 'locator',
        action: { label: 'Add project', run: { kind: 'add-project' } }
      },
      {
        anchor: 'rail-settings',
        shape: 'control',
        eyebrow: 'Connect the work',
        title: 'A provider answers, an agent does',
        description:
          'Gateways holds your model providers and accounts: that is who answers. Harnesses is what can run here, the one built into CodeInOven, one you install yourself, or one an Oven discovers. Nothing runs until both are set.',
        path: ['Rail', 'Settings'],
        tag: 'setup',
        treatment: 'locator',
        action: {
          label: 'Open setup',
          run: { kind: 'open-settings', section: 'gateways' },
          leavesTheView: true
        }
      },
      {
        anchor: 'composer',
        shape: 'region',
        eyebrow: 'Your first message',
        title: 'Say what you want built, in plain words',
        description:
          'The model answers, the permission level decides what it may do on its own, and the thread keeps everything after it. Start here, and the rest of the app fills in around the work.',
        path: ['Body', 'Composer'],
        tag: 'first message',
        treatment: 'anatomy',
        keys: CHAT_SEND_KEYS,
        action: { label: 'Say hello', run: { kind: 'focus-composer' } }
      },
      {
        anchor: 'notifications',
        shape: 'control',
        eyebrow: 'Nothing silent',
        title: 'Finished work reports back here',
        description:
          'Every view raises its own entries on the bell: a run that finished, a spec waiting, a question parked. Each entry opens the thread it came from, so you can leave a long run and come back to exactly what changed.',
        path: ['Header', 'Notifications'],
        tag: 'nothing silent',
        treatment: 'locator'
      }
    ]
  },
  threads: {
    name: 'Thread guide',
    viewName: 'Threads',
    stops: [
      {
        anchor: 'view-switcher',
        shape: 'edge',
        eyebrow: 'Where you are',
        title: "Every project's conversations, in one list",
        description:
          'The rail is the same in every view, and this is the second stop on it. Switching is instant and keeps each view where you left it.',
        path: ['Rail'],
        tag: 'start',
        treatment: 'locator',
        keys: RAIL_KEYS
      },
      {
        anchor: 'view-actions',
        shape: 'region',
        eyebrow: "This view's actions",
        title: 'Search all of it, or narrow it',
        description:
          'One search across every conversation, and the projects you want in the timeline. Switch views and this slot switches with you.',
        path: ['Header', 'View actions'],
        tag: 'orientation',
        treatment: 'locator'
      },
      {
        anchor: 'empty-state-actions',
        shape: 'region',
        eyebrow: 'Start here',
        title: 'A conversation needs a project',
        description:
          'Add a folder as a project and its conversations appear in this timeline as you work. A chat needs no project, so it lives in Chats instead.',
        path: ['Body', 'Start list'],
        tag: 'first action',
        treatment: 'locator'
      },
      {
        anchor: 'notifications',
        shape: 'control',
        eyebrow: 'Nothing silent',
        title: 'Come back to what changed',
        description:
          'A finished thread, a spec waiting, a question parked. Each entry names the project and the thread and opens it, so a long run never has to be watched.',
        path: ['Header', 'Notifications'],
        tag: 'nothing silent',
        treatment: 'locator'
      }
    ]
  },
  chats: {
    name: 'Chat guide',
    viewName: 'Chats',
    stops: [
      {
        anchor: 'view-switcher',
        shape: 'edge',
        eyebrow: 'Where you are',
        title: 'Chats need no project',
        description:
          'A real thread with history, model and attachments that belongs to no folder. Nothing you ask here lands in a project you are working in.',
        path: ['Rail'],
        tag: 'start',
        treatment: 'locator',
        keys: [{ action: 'nav-chats', label: 'Chat' }]
      },
      {
        anchor: 'composer',
        shape: 'region',
        eyebrow: 'Before you send',
        title: 'The composer decides what this chat can do',
        description:
          'The model answers, the permission level decides what it may do on its own, and the plus menu grants file access. Set here, then send.',
        path: ['Body', 'Composer'],
        tag: 'before you send',
        treatment: 'anatomy',
        keys: CHAT_SEND_KEYS,
        action: { label: 'Say hello', run: { kind: 'focus-composer' } }
      },
      {
        anchor: 'view-actions',
        shape: 'region',
        eyebrow: "This view's actions",
        title: 'Find any chat, or start another',
        description:
          'Search every chat by what was said in it, and start a new one without leaving the view. The actions change with the view you are in.',
        path: ['Header', 'View actions'],
        tag: 'orientation',
        treatment: 'locator'
      },
      {
        anchor: 'notifications',
        shape: 'control',
        eyebrow: 'Nothing silent',
        title: 'The answer comes back to you',
        description:
          'A finished reply raises its own entry on the bell, naming the chat it came from. Long answers stop being something you have to sit and wait for.',
        path: ['Header', 'Notifications'],
        tag: 'nothing silent',
        treatment: 'locator'
      }
    ]
  },
  assistant: {
    name: 'Assistant guide',
    viewName: 'Assistant',
    stops: [
      {
        anchor: 'view-switcher',
        shape: 'edge',
        eyebrow: 'Where you are',
        title: 'Work that runs without you has its own room',
        description:
          'Assistants and tasks live here, apart from your project threads, so scheduled work never mixes with the work you are doing by hand.',
        path: ['Rail'],
        tag: 'start',
        treatment: 'locator',
        keys: [{ action: 'nav-assistant', label: 'Assistant' }]
      },
      {
        anchor: 'view-actions',
        shape: 'region',
        eyebrow: "This view's actions",
        title: 'An assistant, a task, or a search',
        description:
          'An assistant takes something off your hands for good and remembers what you tell it. A task is one piece of work inside an assistant.',
        path: ['Header', 'View actions'],
        tag: 'orientation',
        treatment: 'locator',
        keys: [
          { action: 'assistant-new-task', label: 'New task' },
          { action: 'assistant-new-assistant', label: 'New assistant' }
        ]
      },
      {
        anchor: 'empty-state-actions',
        shape: 'region',
        eyebrow: 'Start here',
        title: 'Begin with an assistant',
        description:
          'A new assistant opens its first conversation. It asks what it needs, one thing at a time, and writes down what it learns so every run follows it.',
        path: ['Body', 'Start list'],
        tag: 'first action',
        treatment: 'locator'
      },
      {
        anchor: 'notifications',
        shape: 'control',
        eyebrow: 'Nothing silent',
        title: 'Runs report back',
        description:
          'Every run lands in the sidebar under its assistant and raises its own notice naming that assistant, so a scheduled job never finishes silently.',
        path: ['Header', 'Notifications'],
        tag: 'nothing silent',
        treatment: 'locator'
      }
    ]
  }
}
