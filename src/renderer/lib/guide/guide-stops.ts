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

/**
 * The dock's width, in rem. The dock draws itself at this width and the marker
 * reads the same number to find the edge its rule lands on, because a guide that
 * measured the dock would stop drawing the moment the dock's own rendering is
 * throttled or delayed.
 */
export const GUIDE_DOCK_WIDTH_REM = 21.5

/** The content views that own a guided walk of themselves. */
export type WorkspaceTourView = 'projects' | 'threads' | 'chats' | 'assistant' | 'browser'

/**
 * The guide a shell view owns, or null for a view without one.
 * Scope is the same view as Projects, so it reads the same guide.
 */
export function workspaceTourViewFor(view: string): WorkspaceTourView | null {
  if (view === 'projects-scope') return 'projects'
  return view === 'projects' ||
    view === 'threads' ||
    view === 'chats' ||
    view === 'assistant' ||
    view === 'browser'
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
 * - `harnesses` the agent list: every harness this app knows, Pi first, each one
 *   clickable to the place it is connected or installed.
 * - `actions` the rows a stop offers, one per thing the user can do from here.
 */
export type GuideTreatment = 'locator' | 'anatomy' | 'harnesses' | 'actions'

/** One key row: a keymap action, so a rebind shows up in the guide. */
export interface GuideKey {
  /** Keymap action id, resolved to the user's live chord. */
  action: string
  label: string
}

/**
 * What a stop's own button does, in the app's terms. The guide names the step;
 * the app performs it, because only the app knows how to add a project, open a
 * harness, or put the caret in the composer.
 */
export type GuideActionKind =
  | { kind: 'add-project' }
  | { kind: 'focus-composer' }
  /**
   * Open a harness where it belongs: one this machine already runs opens its
   * provider accounts, and one it does not have yet opens the page that
   * installs it.
   */
  | { kind: 'open-harness'; harnessId: string }
  /** Start this guide over from its first stop. */
  | { kind: 'restart-guide' }
  /** End this guide and walk the target view's own guide instead. */
  | { kind: 'open-view-guide'; view: WorkspaceTourView }
  /** Connect the GitHub account the app reads and manages repositories with. */
  | { kind: 'connect-github' }

export interface GuideAction {
  /** Button label. A verb, short enough for the dock's footer. */
  label: string
  run: GuideActionKind
}

/**
 * One row a stop offers: a thing the user can do from here, in the app's terms.
 *
 * A row does its own job where the user already is, so it never moves the guide
 * on: the stop's own Next is what does that, and a row that hands the user to
 * another view ends the guide it belongs to on purpose.
 */
export interface GuideChoice {
  label: string
  /** One line saying what the row does, drawn under its label. */
  detail: string
  run: GuideActionKind
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
  /**
   * The other way to take that step, for a user the first one does not fit.
   * Drawn quieter and to the left of the primary, never instead of it: a stop
   * asks for one thing and offers one alternative.
   */
  alternative?: GuideAction
  /** The rows this stop offers under its copy, for a `actions` treatment. */
  choices?: readonly GuideChoice[]
  /**
   * What this stop insists on before it lets the user walk on. `harness` holds
   * the guide until this machine has at least one agent it can actually run,
   * either because it came with the app or because the user has just installed
   * or connected one. A stop with a gate can be left only through its Next, so
   * it is the one step a first run cannot skip past.
   */
  gate?: 'harness'
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
 * first-run sequence rather than a description of the view: it names the rail
 * and the header, adds the project, connects an agent, puts the caret in the
 * composer, and closes on the tours the other views own, because a tour that
 * only talks has not onboarded anybody. The other views orient a user who
 * already has work and only need to say what belongs where.
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
        title: 'The rail is where you switch views',
        description:
          'Projects holds the folders you added. Threads gathers the conversations you had in them. Chats need no project at all, and the Assistant runs work without you. The gold square marks the view you are in, and every view keeps its place while you are away.',
        path: ['Rail'],
        tag: 'start',
        treatment: 'locator',
        keys: RAIL_KEYS
      },
      {
        anchor: 'header',
        shape: 'region',
        eyebrow: 'The header',
        title: 'The header names where you are, and takes you back',
        description:
          'The middle names whatever is on screen. The arrows on the left walk back and forward through everywhere you have been, view changes included, so a wrong turn costs one keystroke. Right beside them sit the actions that belong to the view you are in.',
        path: ['Header'],
        tag: 'orientation',
        treatment: 'locator',
        keys: [
          { action: 'nav-history-back', label: 'Back to the last screen' },
          { action: 'nav-history-forward', label: 'Forward again' },
          { action: 'nav-find', label: 'Find in what the view is showing' }
        ]
      },
      {
        anchor: 'empty-state-actions',
        shape: 'region',
        eyebrow: 'Start here',
        title: 'A project is a folder on this computer',
        description:
          'Add a folder you already work in, or clone one from Git. Each project keeps its own threads, its own files and its own runs, and its first thread opens the moment it is added.',
        path: ['Body', 'Start list'],
        tag: 'first action',
        treatment: 'locator',
        action: { label: 'Add project', run: { kind: 'add-project' } }
      },
      {
        anchor: 'rail-settings',
        shape: 'control',
        eyebrow: 'The agent',
        title: 'Pi is already here, so you can start',
        description:
          'Pi comes with CodeInOven, so you can start without installing anything or signing in anywhere. Every other agent this app knows is listed below: pick one and it opens where it belongs, its accounts if this machine already has it, the page that installs it if it does not.',
        path: ['Rail', 'Settings'],
        tag: 'the agent',
        treatment: 'harnesses',
        gate: 'harness'
      },
      {
        anchor: 'composer',
        shape: 'region',
        eyebrow: 'Your first message',
        title: 'Say what you want built, in plain words',
        description:
          'Describe the outcome the way you would describe it to a colleague, and let the agent work out the steps. The model answers, the permission level decides what it may change without asking you first, and everything after it stays in this thread.',
        path: ['Body', 'Composer'],
        tag: 'first message',
        treatment: 'anatomy',
        keys: CHAT_SEND_KEYS,
        action: { label: 'Say hello', run: { kind: 'focus-composer' } }
      },
      {
        anchor: 'notifications',
        shape: 'control',
        eyebrow: 'Nothing happens silently',
        title: 'Finished work reports back on the bell',
        description:
          'A run that finished, a question waiting on you, a spec that needs review: each one lands here, named after the project and the thread it came from, and opens straight back to where the work stopped.',
        path: ['Header', 'Notifications'],
        tag: 'nothing silent',
        treatment: 'locator'
      },
      {
        anchor: 'view-switcher',
        shape: 'edge',
        eyebrow: 'Other actions',
        title: 'Everything else you can start from here',
        description:
          'This tour runs again whenever you want it, from this view’s start list or from the command palette. The other views walk themselves the same way, and connecting GitHub is what lets the app clone, push and open pull requests for you.',
        path: ['Rail'],
        tag: 'other actions',
        treatment: 'actions',
        choices: [
          {
            label: 'Run this tour again',
            detail: 'Start the Projects guide over from its first stop.',
            run: { kind: 'restart-guide' }
          },
          {
            label: 'Chat tour',
            detail: 'Conversations that belong to no project.',
            run: { kind: 'open-view-guide', view: 'chats' }
          },
          {
            label: 'Assistant tour',
            detail: 'Assistants, and the tasks they keep running for you.',
            run: { kind: 'open-view-guide', view: 'assistant' }
          },
          {
            label: 'Browser tour',
            detail: 'A real browser in the app, with the agent on the page.',
            run: { kind: 'open-view-guide', view: 'browser' }
          },
          {
            label: 'Connect GitHub',
            detail: 'Sign in so the app can clone, push and open pull requests.',
            run: { kind: 'connect-github' }
          }
        ]
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
  },
  browser: {
    name: 'Browser guide',
    viewName: 'Browser',
    stops: [
      {
        anchor: 'view-switcher',
        shape: 'edge',
        eyebrow: 'Where you are',
        title: 'A real browser, inside the app',
        description:
          'The browser is one of the rail’s views, with its own tabs, its own logins and its own history. What it shows is the page itself rather than a picture of one, which is why the agent can read it and work on it.',
        path: ['Rail'],
        tag: 'start',
        treatment: 'locator',
        keys: [{ action: 'nav-browser', label: 'Browser' }]
      },
      {
        anchor: 'browser-address',
        shape: 'control',
        eyebrow: 'The way in',
        title: 'One control opens every page',
        description:
          'Type an address, or the words you would have typed into a search engine: one control takes both. Every page opens in its own tab, and the strip beside it is where you move between them.',
        path: ['Body', 'Address bar'],
        tag: 'the way in',
        treatment: 'locator',
        keys: [{ action: 'browser-focus-address', label: 'Focus the address bar' }]
      },
      {
        anchor: 'browser-body',
        shape: 'region',
        eyebrow: 'The page',
        title: 'The agent reads the page you are reading',
        description:
          'Open the agent panel beside a page and that conversation keeps the page as its context. Ask about what is on screen, or ask for the code behind it to change, without copying anything anywhere.',
        path: ['Body', 'Page'],
        tag: 'the page',
        treatment: 'locator'
      }
    ]
  }
}
