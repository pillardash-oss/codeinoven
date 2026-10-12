import type { AppControlActionSummary } from '$shared/app-control'
import { contentViewForThread } from '$lib/content-view-threads'
import { invoke } from '$lib/ipc.svelte'
import {
  isSettingsSection,
  mainViewFor,
  settingsViewForSection
} from '$lib/stores/renderer-recovery'
import { browserStore, loadBrowser } from '$lib/stores/browser-access.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'

/**
 * The renderer's registry of UI actions the app-control bridge may run.
 *
 * Channels cover everything that already has an IPC path, but a person also
 * changes the app in ways no channel models: switching view, opening a panel,
 * opening a browser tab, opening a thread. Those are renderer-local, so the
 * renderer publishes them here and the bridge asks for the list before it runs
 * one.
 *
 * The navigation action is registered by the app shell rather than defined here,
 * because moving the app is the shell's job (it warms chunks and reconciles the
 * open thread). Everything else is a thin wrapper over the singleton stores.
 */

interface AppControlActionParam {
  name: string
  required: boolean
  description: string
}

interface AppControlAction {
  id: string
  description: string
  params: readonly AppControlActionParam[]
  run: (params: Record<string, unknown>) => unknown | Promise<unknown>
}

const actions = new Map<string, AppControlAction>()

/** Register (or replace) one UI action the bridge may invoke. */
export function registerAppControlAction(action: AppControlAction): void {
  actions.set(action.id, action)
}

/** The registered actions, as the catalog tool reports them. */
export function listAppControlActions(): AppControlActionSummary[] {
  return Array.from(actions.values()).map((action) => ({
    id: action.id,
    description: action.description,
    params: action.params.map((param) => (param.required ? param.name : `${param.name}?`))
  }))
}

/** Run one registered UI action by id. */
export async function runAppControlAction(
  id: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const action = actions.get(id)
  if (!action) throw new Error(`Unknown UI action "${id}".`)
  for (const param of action.params) {
    if (param.required && params[param.name] === undefined) {
      throw new Error(`The "${id}" action requires the "${param.name}" parameter.`)
    }
  }
  return action.run(params)
}

function readString(params: Record<string, unknown>, key: string): string | null {
  const value = params[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** The project and thread the current panel context belongs to. */
function activePanelContext(params: Record<string, unknown>): {
  projectId: string
  threadId: string
} {
  const thread = workspaceState.selectedThread
  const projectId = readString(params, 'projectId') ?? thread?.projectId ?? null
  const threadId = readString(params, 'threadId') ?? thread?.id ?? null
  if (!projectId || !threadId) {
    throw new Error(
      'No thread is open. Open or create a thread first, or pass projectId and threadId.'
    )
  }
  return { projectId, threadId }
}

/** Panels that dock into the shared right sidebar, opened from an active thread. */
const CONTEXT_PANEL_OPENERS: Record<string, (projectId: string, threadId: string) => void> = {
  files: (projectId, threadId) => contextSidebarState.openFiles(projectId, threadId),
  diff: (projectId, threadId) => contextSidebarState.openDiff(projectId, threadId),
  git: (projectId, threadId) => contextSidebarState.openGit(projectId, threadId),
  actions: (projectId, threadId) => contextSidebarState.openActions(projectId, threadId),
  sources: (projectId, threadId) => contextSidebarState.openSources(projectId, threadId),
  oven: (projectId, threadId) => contextSidebarState.openOven(projectId, threadId),
  memory: (projectId, threadId) => contextSidebarState.openMemory(projectId, threadId),
  debugger: (projectId, threadId) => contextSidebarState.openDebugger(projectId, threadId),
  'cloud-deployment': (projectId, threadId) =>
    contextSidebarState.openCloudDeployments(projectId, threadId),
  attention: (projectId, threadId) => contextSidebarState.openAttention(projectId, threadId),
  terminal: (projectId, threadId) => contextSidebarState.openPrimaryTerminal(projectId, threadId)
}

/** Global rails that toggle without a thread context. */
const GLOBAL_PANEL_OPENERS: Record<string, () => void> = {
  notifications: () => contextSidebarState.toggleNotifications(),
  'sticky-notes': () => contextSidebarState.toggleStickyNotes()
}

let registered = false

/**
 * Publish the built-in UI actions once.
 *
 * Idempotent: the app shell may call it on every mount, and the registry is a
 * module singleton, so re-registering would only churn the map.
 */
export function registerAppControlBuiltins(): void {
  if (registered) return
  registered = true

  registerAppControlAction({
    id: 'panel.open',
    description:
      'Open a docked panel/rail: files, diff, git, actions, sources, oven, memory, debugger, cloud-deployment, attention, terminal, notifications or sticky-notes.',
    params: [
      { name: 'panel', required: true, description: 'The panel id to open.' },
      { name: 'projectId', required: false, description: 'Defaults to the open thread.' },
      { name: 'threadId', required: false, description: 'Defaults to the open thread.' }
    ],
    run: (params) => {
      const panel = readString(params, 'panel')
      if (panel === null) throw new Error('Provide a "panel" id.')
      const global = GLOBAL_PANEL_OPENERS[panel]
      if (global) {
        global()
        return { opened: panel }
      }
      const opener = CONTEXT_PANEL_OPENERS[panel]
      if (!opener) {
        throw new Error(
          `Unknown panel "${panel}". Known panels: ${Object.keys({ ...CONTEXT_PANEL_OPENERS, ...GLOBAL_PANEL_OPENERS }).join(', ')}.`
        )
      }
      const { projectId, threadId } = activePanelContext(params)
      opener(projectId, threadId)
      return { opened: panel, projectId, threadId }
    }
  })

  registerAppControlAction({
    id: 'panel.close',
    description: 'Hide whatever panel is currently docked in the right sidebar.',
    params: [],
    run: () => {
      contextSidebarState.hide()
      return { closed: true }
    }
  })

  registerAppControlAction({
    id: 'browser.open',
    description:
      "Open a URL in the app's global browser and switch to the browser view. Returns the tab id.",
    params: [{ name: 'url', required: true, description: 'The URL to open.' }],
    run: async (params) => {
      const url = readString(params, 'url')
      if (url === null) throw new Error('Provide a "url".')
      await loadBrowser()
      workspaceState.navigateToBrowser?.()
      const store = browserStore()
      if (!store) throw new Error('The global browser did not load.')
      return { tabId: store.open(url), url }
    }
  })

  registerAppControlAction({
    id: 'thread.open',
    description: 'Open a project thread: select it and switch to its content view.',
    params: [
      { name: 'projectId', required: true, description: "The thread's project id." },
      { name: 'threadId', required: true, description: 'The thread id.' }
    ],
    run: async (params) => {
      const projectId = readString(params, 'projectId')
      const threadId = readString(params, 'threadId')
      if (projectId === null || threadId === null) {
        throw new Error('Provide "projectId" and "threadId".')
      }
      const thread = await invoke('thread:get', projectId, threadId)
      if (!thread) throw new Error(`No thread "${threadId}" in project "${projectId}".`)
      const project = await invoke('project:get', projectId)
      const iconUrl = await invoke('project:getIcon', projectId)
      workspaceState.openThread(thread, project, iconUrl)
      await navigateTo(contentViewForThread(thread))
      return { opened: threadId }
    }
  })

  registerAppControlAction({
    id: 'project.open',
    description: 'Activate a project and switch to the Projects view.',
    params: [{ name: 'projectId', required: true, description: 'The project id.' }],
    run: async (params) => {
      const projectId = readString(params, 'projectId')
      if (projectId === null) throw new Error('Provide a "projectId".')
      await scopeState.activateProject(projectId)
      await navigateTo('projects')
      return { opened: projectId }
    }
  })
}

/** A navigation hook the app shell installs, since moving the app is its job. */
let navigationHook: ((view: string) => void | Promise<void>) | null = null

export function setAppControlNavigation(
  hook: ((view: string) => void | Promise<void>) | null
): void {
  navigationHook = hook
}

/** Move the app to a view through the shell's own navigation. */
export async function navigateTo(view: string): Promise<void> {
  if (!navigationHook) {
    throw new Error('The app shell has not installed the navigation action yet.')
  }
  await navigationHook(view)
}

/**
 * Register the shell-owned navigation actions.
 *
 * The app shell calls this once on mount, because moving the app (warming lazy
 * chunks, reconciling the open thread) is the shell's job and cannot be done
 * from a store. `app.navigate` accepts any real view, and `settings.open`
 * accepts any settings section; both are validated with the same membership
 * tests the recovery parser uses, so an agent cannot name a view that is not one.
 */
export function registerShellNavigationActions(
  navigate: (view: string) => void | Promise<void>
): void {
  setAppControlNavigation(navigate)

  registerAppControlAction({
    id: 'app.navigate',
    description:
      'Switch the app to a view: projects, threads, chats, assistant, browser, scope or settings.',
    params: [{ name: 'view', required: true, description: 'The view id to switch to.' }],
    run: async (params) => {
      const view = readString(params, 'view')
      if (view === null) throw new Error('Provide a "view".')
      const target = mainViewFor(view)
      if (!target) throw new Error(`Unknown view "${view}".`)
      await navigate(target)
      return { view: target }
    }
  })

  registerAppControlAction({
    id: 'settings.open',
    description: `Open a Settings page: profile, general, browser, memory, audits, design, cio-prompts, heartbeat, harnesses, utilities, gateways, computer-use, sound, keymap, cloud-deployments, ovens or about.`,
    params: [{ name: 'section', required: true, description: 'The settings section id.' }],
    run: async (params) => {
      const section = readString(params, 'section')
      if (section === null) throw new Error('Provide a "section".')
      if (!isSettingsSection(section)) throw new Error(`Unknown settings section "${section}".`)
      const target = settingsViewForSection(section)
      await navigate(target)
      return { section }
    }
  })
}
