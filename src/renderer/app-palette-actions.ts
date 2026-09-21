import type { Component } from 'svelte'
import {
  Bell,
  Blocks,
  BookOpen,
  Brain,
  ChartColumn,
  FileSearch,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GraduationCap,
  Info,
  Keyboard,
  LayoutDashboard,
  ListTree,
  MessageSquarePlus,
  MessagesSquare,
  Server,
  SlidersHorizontal,
  SquarePen,
  Terminal,
  Users,
  Wrench
} from '@lucide/svelte'
import { APP_NAME } from '$shared/brand'
import { INBOX_PROJECT_ID, type Project, type Thread } from '$shared/types'
import type { ActionDefinition, ActionSource } from '$lib/actions'
import type { MainView, SettingsSection } from '$lib/stores/renderer-recovery'

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
    icon: FolderOpen,
    keywords: ['workspace', 'threads']
  },
  {
    id: 'app:chats',
    title: 'Open chats',
    description: 'Browse standalone conversations',
    category: 'navigation',
    source: applicationSource,
    icon: MessagesSquare,
    keywords: ['conversations', 'messages']
  },
  {
    id: 'app:scope',
    title: 'Open scope',
    description: 'Review work across projects',
    category: 'navigation',
    source: applicationSource,
    icon: LayoutDashboard,
    keywords: ['board', 'overview']
  },
  {
    id: 'app:threads',
    title: 'Open threads',
    description: 'Browse threads across all projects',
    category: 'navigation',
    source: applicationSource,
    icon: ListTree,
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
    icon: SlidersHorizontal
  },
  {
    id: 'memory',
    label: 'Memory',
    keywords: ['instructions', 'knowledge'],
    icon: Brain
  },
  {
    id: 'audits',
    label: 'Agents',
    keywords: ['senior engineer', 'worker', 'auditor', 'achievement', 'review'],
    icon: Users
  },
  {
    id: 'harnesses',
    label: 'Harnesses',
    keywords: ['models', 'providers', 'harnesses'],
    icon: Blocks
  },
  {
    id: 'utilities',
    label: 'Utilities',
    keywords: ['mcp', 'skills', 'capabilities', 'computer use', 'tools'],
    icon: Wrench
  },
  {
    id: 'keymap',
    label: 'Keymap',
    keywords: ['shortcuts', 'keyboard', 'keys', 'hotkeys', 'bindings'],
    icon: Keyboard
  },
  { id: 'remote', label: 'Remote', keywords: ['ssh', 'host'], icon: Server },
  {
    id: 'profile',
    label: 'Usage',
    keywords: ['account', 'usage', 'activity', 'tokens', 'cost', 'cloud'],
    icon: ChartColumn
  },
  {
    id: 'about',
    label: 'About',
    keywords: ['version', 'updates', 'storage', 'data', 'diagnostics', 'logs', 'debug'],
    icon: Info
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
  const scopedThreadsActive =
    (activeView === 'projects' || activeView === 'projects-scope') && Boolean(sidebarContext)
  const hasLocalProjects = projectRecords.some(
    (project) => !project.hidden && project.source === 'local' && project.path
  )
  const actions: ActionDefinition[] = [
    {
      id: 'app:new-project',
      title: 'Create new project',
      description: 'Choose how to add a project   local folder or SSH',
      category: 'command',
      source: applicationSource,
      icon: FolderPlus,
      shortcut: ['Ctrl', 'Shift', 'N'],
      keywords: ['add', 'folder', 'repository', 'ssh', 'remote']
    },
    {
      id: 'app:notifications',
      title: 'Toggle notifications',
      description: 'Open or close the notifications sidebar',
      category: 'navigation',
      source: applicationSource,
      icon: Bell,
      keywords: ['alerts', 'completed', 'attention']
    },
    {
      id: 'app:getting-started',
      title: 'Open getting started guide',
      description: 'Tour the workspace and set up a project and coding agent',
      category: 'navigation',
      source: applicationSource,
      icon: GraduationCap,
      keywords: ['onboarding', 'tour', 'help', 'setup', 'pi']
    }
  ]

  if (hasLocalProjects) {
    actions.push({
      id: 'app:file-search',
      title: 'Search files across projects',
      description: 'Find and open a file from any local project',
      category: 'file',
      source: applicationSource,
      icon: FileSearch,
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
      icon: MessageSquarePlus,
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
      icon: SquarePen,
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
      icon: SquarePen,
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
      icon: SquarePen,
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
        icon: Terminal,
        keywords: ['shell', 'console', 'command line', 'run']
      },
      {
        id: 'app:git',
        title: 'Open git panel',
        description: 'View changes, commits and branches for this project',
        category: 'navigation',
        source: applicationSource,
        icon: GitBranch,
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
        icon: Brain,
        keywords: ['prompt', 'instructions', 'context']
      },
      {
        id: 'app:sources',
        title: 'Toggle sources sidebar',
        description: 'View sources attached to this conversation',
        category: 'navigation',
        source: applicationSource,
        icon: BookOpen,
        keywords: ['citations', 'references', 'attachments']
      }
    )
  }

  if (hasLocalProjects) {
    // Unshifted last so it always lands first in the palette.
    actions.unshift({
      id: 'app:thread-search',
      title: 'Search threads across projects',
      description: 'Find a conversation by title or message content in any project',
      category: 'thread',
      source: applicationSource,
      icon: MessagesSquare,
      keywords: ['quick open', 'find', 'conversation', 'messages', 'timeline']
    })
  }

  return actions
}
