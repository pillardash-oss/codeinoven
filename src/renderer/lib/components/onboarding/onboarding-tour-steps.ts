/**
 * The spotlight step data behind the first-run setup tour.
 *
 * A view's own walk moved to the guide dock, which talks beside the app instead
 * of over it ($lib/guide/guide-stops.ts). This module keeps what only first-run
 * setup still needs: the workspace as a whole, before any view has content to
 * explain. A step names the element it points at by `data-onboarding` value:
 * when that element is not on screen the tour falls back to a centered callout,
 * so a step never breaks, it only stops pointing.
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

import { isMacPlatform } from '$lib/shortcut-display'

/** The short tours' key rows need the same platform as the keymap itself. */
const isMac = isMacPlatform()

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
    description: `The rail down the left edge switches how the workspace is organized. Projects groups conversations by folder (${shortcutKey('1')}). Threads lists every project conversation (${shortcutKey('2')}). Scoped threads opens the scope sidebar over Projects (${shortcutKey('3')}), Scope Board opens the full-page board (${shortcutKey('4')}), Chats is for work that does not need a project (${shortcutKey('0')}), and Assistant holds assistants and tasks (${shortcutKey('9')}).`
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
