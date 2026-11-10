import CioBoard from '@pdslng/cio-icon/CioBoard.svelte'
import CioBook from '@pdslng/cio-icon/CioBook.svelte'
import CioBrowser from '@pdslng/cio-icon/CioBrowser.svelte'
import CioChat from '@pdslng/cio-icon/CioChat.svelte'
import CioFind from '@pdslng/cio-icon/CioFind.svelte'
import CioFolderOpen from '@pdslng/cio-icon/CioFolderOpen.svelte'
import CioFolderPlus from '@pdslng/cio-icon/CioFolderPlus.svelte'
import CioLayers from '@pdslng/cio-icon/CioLayers.svelte'
import CioLearn from '@pdslng/cio-icon/CioLearn.svelte'
import CioMemory from '@pdslng/cio-icon/CioMemory.svelte'
import CioMessagePlus from '@pdslng/cio-icon/CioMessagePlus.svelte'
import CioNotifications from '@pdslng/cio-icon/CioNotifications.svelte'
import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
import CioProjects from '@pdslng/cio-icon/CioProjects.svelte'
import CioTabGit from '@pdslng/cio-icon/CioTabGit.svelte'
import CioThreadBrowser from '@pdslng/cio-icon/CioThreadBrowser.svelte'
import CioTabSettings from '@pdslng/cio-icon/CioTabSettings.svelte'
import CioTerminal from '@pdslng/cio-icon/CioTerminal.svelte'
import CioThreads from '@pdslng/cio-icon/CioThreads.svelte'
import { APP_NAME } from '$shared/brand'
import { CONTENT_FAMILY_ICONS } from '$lib/content-view-icons'
import { INBOX_PROJECT_ID, type Project, type Thread } from '$shared/types'
import type { ActionDefinition, ActionSource } from '$lib/actions'
import { viewShowsScopedSidebar } from '$lib/content-view-projects'
import type { MainView } from '$lib/stores/renderer-recovery'
import { VIEW_GUIDES, workspaceTourViewFor } from '$lib/guide/guide-stops'

export function actionId(value: string): ActionDefinition['id'] {
  return value as ActionDefinition['id']
}

export const applicationSource = {
  id: 'application',
  label: APP_NAME,
  kind: 'app'
} satisfies ActionSource

export const navigationActions = [
  {
    id: 'app:projects',
    title: 'Open projects',
    description: 'Browse projects and engineering threads',
    category: 'navigation',
    source: applicationSource,
    icon: CioFolderOpen,
    keywords: ['workspace', 'threads']
  },
  {
    id: 'app:chats',
    title: 'Open chats',
    description: 'Browse standalone conversations',
    category: 'navigation',
    source: applicationSource,
    icon: CioChat,
    keywords: ['conversations', 'messages']
  },
  {
    id: 'app:scope',
    title: 'Open scope',
    description: 'Review work across projects',
    category: 'navigation',
    source: applicationSource,
    icon: CioBoard,
    keywords: ['board', 'overview']
  },
  {
    id: 'app:threads',
    title: 'Open threads',
    description: 'Browse threads across all projects',
    category: 'navigation',
    source: applicationSource,
    icon: CioThreads,
    keywords: ['timeline', 'all']
  }
] satisfies ActionDefinition[]

/**
 * The one settings entry the palette carries. Which tab to open next is the
 * settings page's own business: a flattened list of every tab turned the
 * spotlight into a second sidebar, so the palette opens settings and the user
 * navigates from there.
 */
export const openSettingsAction: ActionDefinition = {
  id: actionId('app:settings'),
  title: 'Open settings',
  description: 'Appearance, memory, harnesses, utilities, keymap, and more',
  category: 'navigation',
  source: applicationSource,
  icon: CioTabSettings,
  keywords: [
    'settings',
    'preferences',
    'appearance',
    'theme',
    'font',
    'sound',
    'speech',
    'keymap',
    'shortcuts',
    'harness',
    'utilities',
    'memory',
    'browser',
    'archives',
    'about'
  ],
  shortcut: ['Ctrl', ',']
}

/** Minimal shape of the scope sidebar context the palette needs. */
interface PaletteScopeSidebarContext {
  projectId: string
  bucketId: string
}

export interface PaletteContextInput {
  activeView: MainView
  projectRecords: Project[]
  activeProjectId: string | null
  sidebarContext: PaletteScopeSidebarContext | null
  activeProject: Project | null
  selectedThread: Thread | null
}

/**
 * View-dependent palette actions: the ones whose presence or target changes
 * with the active view, the open thread, and the local project set.
 */
export function buildPaletteContextActions(input: PaletteContextInput): ActionDefinition[] {
  const { activeView, projectRecords, activeProjectId, sidebarContext } = input
  const workspaceVisible =
    activeView === 'projects' ||
    activeView === 'projects-scope' ||
    activeView === 'chats' ||
    activeView === 'threads'
  // The scoped threads view is the docked scope sidebar: the shell reports it
  // either as its own `projects-scope` view or as `projects` with a live sidebar
  // context, so the new-thread action follows the docked scope in both cases.
  const scopedThreadsActive = viewShowsScopedSidebar(activeView, sidebarContext !== null)
  const hasLocalProjects = projectRecords.some(
    (project) => !project.hidden && project.source === 'local' && project.path
  )
  // Every view that owns an empty state also owns a tour of itself, and this is
  // the one entry point every view has: a view's empty state offers it too, but
  // Chats has no action list of its own to offer it from.
  const tourView = workspaceTourViewFor(activeView)
  const thread = workspaceVisible ? input.selectedThread : null
  const threadProject = thread
    ? projectRecords.find((candidate) => candidate.id === thread.projectId)
    : undefined

  // The spotlight home is an action list, nothing else. Its searches come first,
  // because a query on the home screen is a search, and each one opens its own
  // screen with its own sub-container filter: the unified search over every
  // thread family, then project threads (only with a local project to search),
  // the standalone chats, the assistant tasks, the browser's open tabs, and the
  // files of any local project.
  const searchActions: ActionDefinition[] = [
    {
      id: 'app:all-thread-search',
      title: 'Search all threads',
      description: 'One search across project threads, standalone chats, and assistant tasks',
      category: 'thread',
      source: applicationSource,
      // The stacked-families mark: this entry is every thread the app holds, not
      // one family's own glyph.
      icon: CioLayers,
      keywords: [
        'quick open',
        'find',
        'everything',
        'all',
        'conversation',
        'messages',
        'projects',
        'chats',
        'assistant'
      ]
    },
    ...(hasLocalProjects
      ? [
          {
            id: 'app:thread-search',
            title: 'Search threads across projects',
            description: 'Find an engineering thread by title or message content in any project',
            category: 'thread',
            source: applicationSource,
            // The Threads view's rail mark, not the generic chat bubble.
            icon: CioThreads,
            keywords: ['quick open', 'find', 'conversation', 'messages', 'timeline', 'project']
          } satisfies ActionDefinition
        ]
      : []),
    {
      id: 'app:chat-search',
      title: 'Search chats',
      description: 'Find a standalone conversation by title or message content',
      category: 'thread',
      source: applicationSource,
      // Same mark the view rail gives the Chats view, so the entry reads as
      // "Chat" at a glance instead of a second, unrelated conversation glyph.
      icon: CONTENT_FAMILY_ICONS.chats,
      keywords: ['quick open', 'find', 'conversation', 'messages', 'chats', 'inbox']
    },
    {
      id: 'app:assistant-search',
      title: 'Search assistant tasks',
      description: 'Find an assistant task or assistant by name, title, or message content',
      category: 'assistant',
      source: applicationSource,
      // The Assistant view's rail mark, kept from the one shared source.
      icon: CONTENT_FAMILY_ICONS.assistant,
      keywords: ['quick open', 'find', 'assistant', 'task', 'schedule']
    },
    {
      id: 'app:browser-tab-search',
      title: 'Search browser tabs',
      description: 'Find an open tab by title, address, or group',
      category: 'browser',
      source: applicationSource,
      // The Browser view's rail mark.
      icon: CioBrowser,
      keywords: ['quick open', 'find', 'tab', 'browser', 'group', 'url']
    },
    ...(hasLocalProjects
      ? [
          {
            id: 'app:file-search',
            title: 'Search files across projects',
            description: 'Find and open a file from any local project',
            category: 'file',
            source: applicationSource,
            icon: CioFind,
            keywords: ['quick open', 'find', 'workspace']
          } satisfies ActionDefinition
        ]
      : [])
  ]

  // Then the one primary action the current view is able to start.
  const primaryActions: ActionDefinition[] = []
  if (activeView === 'chats') {
    primaryActions.push({
      id: 'app:new-chat',
      title: 'New chat',
      description: 'Start a standalone conversation',
      category: 'command',
      source: applicationSource,
      icon: CioMessagePlus,
      shortcut: ['Ctrl', 'N'],
      keywords: ['conversation', 'message']
    })
  } else if (activeView === 'scope' && activeProjectId) {
    const project = projectRecords.find((candidate) => candidate.id === activeProjectId)
    primaryActions.push({
      id: 'app:new-thread',
      title: 'New thread',
      description: project ? `Create a thread in ${project.name}` : 'Create a project thread',
      category: 'command',
      source: applicationSource,
      icon: CioPencil,
      shortcut: ['Ctrl', 'N'],
      keywords: ['task', 'conversation', 'project']
    })
  } else if (scopedThreadsActive && sidebarContext) {
    const project = projectRecords.find((candidate) => candidate.id === sidebarContext.projectId)
    primaryActions.push({
      id: 'app:new-thread',
      title: 'New thread',
      description: project ? `Create a thread in ${project.name}` : 'Create a project thread',
      category: 'command',
      source: applicationSource,
      icon: CioPencil,
      shortcut: ['Ctrl', 'N'],
      keywords: ['task', 'conversation', 'project', 'scope']
    })
  } else if (
    (activeView === 'projects' || activeView === 'threads') &&
    input.activeProject &&
    input.activeProject.id !== INBOX_PROJECT_ID
  ) {
    primaryActions.push({
      id: 'app:new-thread',
      title: 'New thread',
      description: `Create a thread in ${input.activeProject.name}`,
      category: 'command',
      source: applicationSource,
      icon: CioPencil,
      shortcut: ['Ctrl', 'N'],
      keywords: ['task', 'conversation', 'project']
    })
  }

  // Adding and switching projects, in that order: creating one is the action a
  // user reaches for before they have a project to switch to.
  const projectActions: ActionDefinition[] = [
    {
      id: 'app:new-project',
      title: 'Create new project',
      description: 'Choose how to add a project   local folder or Oven over SSH',
      category: 'command',
      source: applicationSource,
      icon: CioFolderPlus,
      shortcut: ['Ctrl', 'Shift', 'N'],
      keywords: ['add', 'folder', 'repository', 'oven', 'ssh', 'remote']
    },
    {
      id: 'app:switch-project',
      title: 'Switch project',
      description: 'Pick a project to focus on',
      category: 'navigation',
      source: applicationSource,
      icon: CioProjects,
      keywords: ['focus', 'open', 'change', 'select', 'workspace', 'project'],
      ...(projectRecords.length === 0 ? { disabledReason: 'No projects yet' } : {})
    }
  ]

  // The two browsers. The app's own browser is always available; the open
  // thread's browser only exists while a thread is on screen to own it, and it
  // wears the thread-browser mark its sidebar tab already uses.
  const browserActions: ActionDefinition[] = [
    {
      id: 'app:browser',
      title: 'Open global browser',
      description: `Open the ${APP_NAME} browser and its tabs`,
      category: 'navigation',
      source: applicationSource,
      icon: CioBrowser,
      keywords: ['web', 'browse', 'tab', 'page', 'site', 'address', 'url']
    },
    ...(thread
      ? [
          {
            id: 'app:thread-browser',
            title: 'Open thread browser',
            description: "Open this thread's browser, or start a new tab to begin browsing",
            category: 'navigation',
            source: applicationSource,
            icon: CioThreadBrowser,
            keywords: ['browser', 'web', 'browse', 'tab', 'page', 'site', 'address', 'url']
          } satisfies ActionDefinition
        ]
      : [])
  ]

  // The thread's own panels, only while a thread is on screen to own them.
  const threadActions: ActionDefinition[] = thread
    ? [
        {
          id: 'app:terminal',
          title: 'Open terminal',
          description: 'Open a terminal for this thread',
          category: 'navigation',
          source: applicationSource,
          icon: CioTerminal,
          keywords: ['shell', 'console', 'command line', 'run']
        },
        {
          id: 'app:git',
          title: 'Open git panel',
          description: 'View changes, commits and branches for this project',
          category: 'navigation',
          source: applicationSource,
          icon: CioTabGit,
          keywords: ['changes', 'commits', 'branches', 'status', 'diff'],
          ...(threadProject?.changeTrackingMode !== 'git'
            ? { disabledReason: 'This project does not use Git tracking' }
            : {})
        },
        {
          id: 'app:memory',
          title: 'Toggle memory sidebar',
          description: 'View the memory context available to this thread',
          category: 'navigation',
          source: applicationSource,
          icon: CioMemory,
          keywords: ['prompt', 'instructions', 'context']
        },
        {
          id: 'app:sources',
          title: 'Toggle sources sidebar',
          description: 'View sources attached to this conversation',
          category: 'navigation',
          source: applicationSource,
          icon: CioBook,
          keywords: ['citations', 'references', 'attachments']
        }
      ]
    : []

  const appActions: ActionDefinition[] = [
    openSettingsAction,
    {
      id: 'app:notifications',
      title: 'Toggle notifications',
      description: 'Open or close the notifications sidebar',
      category: 'navigation',
      source: applicationSource,
      icon: CioNotifications,
      keywords: ['alerts', 'completed', 'attention']
    },
    ...(tourView
      ? [
          {
            id: 'app:tour-view',
            title: `Learn what the ${VIEW_GUIDES[tourView].viewName} view can do`,
            description: 'Walk through this view with pointers, one step at a time',
            category: 'navigation',
            source: applicationSource,
            icon: CioLearn,
            keywords: ['tour', 'onboarding', 'walkthrough', 'guide', 'help', 'tips']
          } satisfies ActionDefinition
        ]
      : [])
  ]

  return [
    ...searchActions,
    ...primaryActions,
    ...projectActions,
    ...browserActions,
    ...threadActions,
    ...appActions
  ]
}
