import CioBoard from '@pillardash-oss/cio-icon/CioBoard.svelte'
import CioBook from '@pillardash-oss/cio-icon/CioBook.svelte'
import CioBrowser from '@pillardash-oss/cio-icon/CioBrowser.svelte'
import CioChart from '@pillardash-oss/cio-icon/CioChart.svelte'
import CioChat from '@pillardash-oss/cio-icon/CioChat.svelte'
import CioFind from '@pillardash-oss/cio-icon/CioFind.svelte'
import CioFolderOpen from '@pillardash-oss/cio-icon/CioFolderOpen.svelte'
import CioFolderPlus from '@pillardash-oss/cio-icon/CioFolderPlus.svelte'
import CioHarness from '@pillardash-oss/cio-icon/CioHarness.svelte'
import CioKeyboard from '@pillardash-oss/cio-icon/CioKeyboard.svelte'
import CioLearn from '@pillardash-oss/cio-icon/CioLearn.svelte'
import CioMemory from '@pillardash-oss/cio-icon/CioMemory.svelte'
import CioMessagePlus from '@pillardash-oss/cio-icon/CioMessagePlus.svelte'
import CioNotifications from '@pillardash-oss/cio-icon/CioNotifications.svelte'
import CioPencil from '@pillardash-oss/cio-icon/CioPencil.svelte'
import CioProjects from '@pillardash-oss/cio-icon/CioProjects.svelte'
import CioTabGit from '@pillardash-oss/cio-icon/CioTabGit.svelte'
import CioTabInfo from '@pillardash-oss/cio-icon/CioTabInfo.svelte'
import CioTabSettings from '@pillardash-oss/cio-icon/CioTabSettings.svelte'
import CioTeam from '@pillardash-oss/cio-icon/CioTeam.svelte'
import CioTerminal from '@pillardash-oss/cio-icon/CioTerminal.svelte'
import CioThreads from '@pillardash-oss/cio-icon/CioThreads.svelte'
import CioWrench from '@pillardash-oss/cio-icon/CioWrench.svelte'
import type { Component } from 'svelte'
import { APP_NAME } from '$shared/brand'
import { CONTENT_FAMILY_ICONS } from '$lib/content-view-icons'
import { INBOX_PROJECT_ID, type Project, type Thread } from '$shared/types'
import type { ActionDefinition, ActionSource } from '$lib/actions'
import { viewShowsScopedSidebar } from '$lib/content-view-projects'
import type { MainView, SettingsSection } from '$lib/stores/renderer-recovery'
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

export const settingsTabs: Array<{
  id: SettingsSection
  label: string
  keywords: string[]
  icon: Component
}> = [
  {
    id: 'general',
    label: 'General',
    keywords: ['appearance', 'theme', 'preferences'],
    icon: CioTabSettings
  },
  {
    id: 'browser',
    label: 'Browser',
    keywords: ['search engine', 'address bar', 'links', 'tabs', 'prototype', 'cdn'],
    icon: CioBrowser
  },
  {
    id: 'memory',
    label: 'Memory',
    keywords: ['instructions', 'knowledge'],
    icon: CioMemory
  },
  {
    id: 'audits',
    label: 'Agents',
    keywords: ['senior engineer', 'worker', 'auditor', 'achievement', 'review'],
    icon: CioTeam
  },
  {
    id: 'harnesses',
    label: 'Harnesses',
    keywords: ['models', 'providers', 'harnesses'],
    icon: CioHarness
  },
  {
    id: 'utilities',
    label: 'Utilities',
    keywords: ['mcp', 'skills', 'capabilities', 'computer use', 'tools'],
    icon: CioWrench
  },
  {
    id: 'keymap',
    label: 'Keymap',
    keywords: ['shortcuts', 'keyboard', 'keys', 'hotkeys', 'bindings'],
    icon: CioKeyboard
  },
  {
    id: 'profile',
    label: 'Usage',
    keywords: ['usage', 'activity', 'tokens', 'cost', 'rankings'],
    icon: CioChart
  },
  {
    id: 'about',
    label: 'About',
    keywords: ['version', 'updates', 'storage', 'data', 'diagnostics', 'logs', 'debug'],
    icon: CioTabInfo
  }
]

export const settingsActions = settingsTabs.map((tab): ActionDefinition => ({
  id: actionId(`settings:${tab.id}`),
  title: `Settings: ${tab.label}`,
  description: `Open the ${tab.label} settings tab`,
  category: 'navigation',
  source: applicationSource,
  icon: tab.icon,
  keywords: ['settings', 'preferences', ...tab.keywords],
  ...(tab.id === 'general' ? { shortcut: ['Ctrl', ','] } : {})
}))

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
  const actions: ActionDefinition[] = [
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
      : []),
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
    },
    {
      id: 'app:notifications',
      title: 'Toggle notifications',
      description: 'Open or close the notifications sidebar',
      category: 'navigation',
      source: applicationSource,
      icon: CioNotifications,
      keywords: ['alerts', 'completed', 'attention']
    }
  ]

  if (hasLocalProjects) {
    actions.push({
      id: 'app:file-search',
      title: 'Search files across projects',
      description: 'Find and open a file from any local project',
      category: 'file',
      source: applicationSource,
      icon: CioFind,
      keywords: ['quick open', 'find', 'workspace']
    })
  }

  if (activeView === 'chats') {
    actions.unshift({
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
    actions.unshift({
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
    actions.unshift({
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
    actions.unshift({
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

  const thread = workspaceVisible ? input.selectedThread : null
  if (thread) {
    const threadProject = projectRecords.find((candidate) => candidate.id === thread.projectId)
    actions.push(
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
    )
  }

  // The search entries are one block at the top of the palette, in family order:
  // project threads first (only with a local project to search), then the
  // standalone chats, the assistant tasks/assistants, and the browser's open tabs.
  // Each opens its own screen with its own sub-container filter.
  const familySearchActions: ActionDefinition[] = [
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
      keywords: ['quick open', 'find', 'assistant', 'assistant', 'task', 'schedule']
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
    }
  ]
  actions.unshift(
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
    ...familySearchActions
  )

  return actions
}
