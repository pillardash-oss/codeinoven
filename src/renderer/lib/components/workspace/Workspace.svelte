<script lang="ts">
  import AssistantKnowledgeIcon from '$lib/components/icons/cio/AssistantKnowledgeIcon.svelte'
  import CioActions from '@pdslng/cio-icon/CioActions.svelte'
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import CioCloud from '@pdslng/cio-icon/CioCloud.svelte'
  import CioDebugger from '@pdslng/cio-icon/CioDebugger.svelte'
  import CioDiff from '@pdslng/cio-icon/CioDiff.svelte'
  import CioFiles from '@pdslng/cio-icon/CioFiles.svelte'
  import CioHistory from '@pdslng/cio-icon/CioHistory.svelte'
  import CioMemory from '@pdslng/cio-icon/CioMemory.svelte'
  import CioSubagent from '@pdslng/cio-icon/CioSubagent.svelte'
  import CioTabInfo from '@pdslng/cio-icon/CioTabInfo.svelte'
  import CioTemporaryChat from '@pdslng/cio-icon/CioTemporaryChat.svelte'
  import CioTerminal from '@pdslng/cio-icon/CioTerminal.svelte'
  import CioThreadBrowser from '@pdslng/cio-icon/CioThreadBrowser.svelte'
  import { feature } from '$lib/feature-registry'
  import { motionDuration } from '$lib/motion'
  import { assistants } from '$lib/stores/assistants.svelte'
  import { attentionState } from '$lib/stores/attention.svelte'
  import { browserStore } from '$lib/stores/browser-access.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { designCoordinatorState } from '$lib/stores/design-coordinator.svelte'
  import { captureActivities } from '$shared/media-activity'
  import { browserAudio } from '$lib/stores/browser-audio.svelte'
  import { projectWorkState } from '$lib/stores/project-work.svelte'
  import {
    AUTHORED_WORK_ICON_BY_KIND,
    AUTHORED_WORK_NAME_BY_KIND,
    authoredWorkOwnerLabel
  } from '$lib/authored-work-presentation'
  import { memoryProposalState } from '$lib/stores/memory-proposals.svelte'
  import { ovens } from '$lib/stores/ovens.svelte'
  import { projectActionsState } from '$lib/stores/project-actions.svelte'
  import { threadChangesState } from '$lib/stores/thread-changes.svelte'
  import { threadNotesState } from '$lib/stores/thread-notes.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import type { Project } from '$shared/types'
  import { activeThreadRowId, ASSISTANT_SPACE_ID, INBOX_PROJECT_ID } from '$shared/types'
  import { cubicOut } from 'svelte/easing'
  import { SvelteSet } from 'svelte/reactivity'
  import { fly } from 'svelte/transition'
  import AssistantOwnerPicker from '../assistant/AssistantOwnerPicker.svelte'
  import ContextDock, { type ContextDockItem } from '../layout/ContextDock.svelte'
  import ChangeSummaryFlyout from '../layout/ChangeSummaryFlyout.svelte'
  import ContextSidebar from '../layout/ContextSidebar.svelte'
  import { fullscreenFileChatHost } from '$lib/fullscreen-file-chat-portal'
  import ThreadSwitcher from '../threads/ThreadSwitcher.svelte'
  import ContinueInProjectModal from '../threads/ContinueInProjectModal.svelte'
  import WorkspaceContextPanelContent from './WorkspaceContextPanelContent.svelte'
  import WorkspaceConversationPane from './WorkspaceConversationPane.svelte'
  import WorkspaceEditProjectModal from './WorkspaceEditProjectModal.svelte'
  import WorkspaceHistoryMenu from './WorkspaceHistoryMenu.svelte'
  import WorkspaceRemoveProjectModals from './WorkspaceRemoveProjectModals.svelte'
  import WorkspaceSidebar from './WorkspaceSidebar.svelte'
  import WorkspaceTerminalDockContent from './WorkspaceTerminalDockContent.svelte'
  import WorkspaceUnsavedChangesDialog from './WorkspaceUnsavedChangesDialog.svelte'
  import { createWorkspace } from './Workspace/Workspace-board.svelte'
  import type { Props } from './Workspace/Workspace-types'

  let {
    mode,
    active = true,
    scopeViewActive = false,
    navigate,
    lastProjectViewLanding = () => 'projects',
    config,
    updateConfig
  }: Props = $props()
  const board = createWorkspace(() => ({
    mode,
    active,
    scopeViewActive,
    navigate,
    lastProjectViewLanding,
    config,
    updateConfig
  }))
  /**
   * Dock contents, grouped: history, then workspace tools, then session tools.
   * Every entry is a toggle   the rail itself is always visible, only the
   * panel (or, for history, the floating jump menu) comes and goes.
   */
  board.switcherPanelTabs.setContextGroups(() => dockGroups)
  let dockGroups = $derived.by((): ContextDockItem[][] => {
    if (!selectedThread) return []

    // Chats are pure conversations: their rail only carries session tools
    // (sources, memory, debugger in dev)   never project, terminal or cloud tools.
    const isChatThread = selectedThread.projectId === INBOX_PROJECT_ID
    // Assistant tasks are conversations too: their rail adds the knowledge panel
    // and mounts the file tree on the task's own working directory, but it still
    // carries no terminal, actions or cloud tools.
    const isAssistantThread = selectedThread.projectId === ASSISTANT_SPACE_ID
    const isConversation = isChatThread || isAssistantThread

    // The message-history counter leads the rail so it reads first, like a
    // running tally of the conversation   click to jump to any past message.
    // Before the first message it falls back to a plain history icon: there's
    // no count worth showing yet, and "0" reads as a stuck/broken badge.
    const hasMessages = workspaceState.messageCount > 0
    const history: ContextDockItem[] = [
      {
        id: 'history',
        label: hasMessages
          ? `Message history (${workspaceState.messageCount} messages you sent)`
          : 'Message history',
        icon: hasMessages ? undefined : CioHistory,
        countLabel: hasMessages ? String(workspaceState.messageCount) : undefined,
        active: board.jumpToHistoryMessage.showHistoryMenu,
        menu: board.jumpToHistoryMessage.showHistoryMenu ? historyMenu : undefined,
        onSelect: () =>
          (board.jumpToHistoryMessage.showHistoryMenu = !board.jumpToHistoryMessage.showHistoryMenu)
      }
    ]

    // The knowledge panel is an assistant task's own authoring surface: it sits
    // right under history, above the workspace tools.
    const assistantTools: ContextDockItem[] = isAssistantThread
      ? [
          {
            id: 'assistant-knowledge',
            label: 'Assistant behavior',
            icon: AssistantKnowledgeIcon,
            active: board.switcherPanelTabs.dockKindActive('assistant-knowledge'),
            onSelect: () =>
              board.switcherPanelTabs.toggleDockPanel('assistant-knowledge', () =>
                board.mergeThreadsInList.openAssistantKnowledgeForTask(selectedThread)
              )
          }
        ]
      : []

    const workspaceTools: ContextDockItem[] = []
    if (selectedThread.settings?.ovenId && selectedThread.settings.ovenId !== 'local') {
      // The Oven's tool stands for the Oven itself: its own mark and colour ride
      // the rail, and its name is what the tooltip and the accessible name say.
      const identity = ovens.identity(selectedThread.settings.ovenId)
      workspaceTools.push({
        id: 'oven',
        label: identity?.name ?? 'Oven',
        icon: CioTerminal,
        ...(identity && !identity.local
          ? { appearance: { color: identity.color, iconUrl: identity.iconUrl } }
          : {}),
        active: board.switcherPanelTabs.dockKindActive('oven'),
        onSelect: () =>
          board.switcherPanelTabs.toggleDockPanel('oven', () =>
            contextSidebarState.openOven(selectedThread.projectId, selectedThread.id)
          )
      })
    }

    // Conversations surface their own app-owned workspace directory as the file
    // tree: a chat's artifact directory, or an assistant task's working
    // directory (the assistant's root).
    if (isConversation) {
      workspaceTools.push({
        id: 'files',
        label: isChatThread ? 'Artifacts' : 'Workspace files',
        icon: CioFiles,
        active: board.switcherPanelTabs.dockKindActive('files'),
        onSelect: () =>
          board.switcherPanelTabs.toggleDockPanel(
            'files',
            () => void board.openThreadFromSwitcher.openFiles()
          )
      })
    }
    if (!isConversation && board.openThreadFromSwitcher.projectToolsAvailable) {
      const changeFileCount = threadChangesState.fileCount
      const changeTotals = threadChangesState.totals
      const hasRecordedChanges = threadChangesState.current !== null && changeFileCount > 0
      // The label doubles as the rail's tooltip and accessible name. The line
      // changes live in the hover flyout, so repeating them here would show the
      // same numbers twice on one hover.
      const changeLabel = 'Changes'
      // While the turn runs, the icon itself carries the running insertions and
      // deletions as plain, colour-coded text on one line ("+128/-24"), so the
      // change is visible without a hover and without a badge frame.
      const changeText =
        threadChangesState.working && changeTotals
          ? [
              ...(changeTotals.additions > 0
                ? [{ text: `+${changeTotals.additions}`, tone: 'success' as const }]
                : []),
              ...(changeTotals.additions > 0 && changeTotals.deletions > 0
                ? [{ text: '/', tone: 'neutral' as const }]
                : []),
              ...(changeTotals.deletions > 0
                ? [{ text: `-${changeTotals.deletions}`, tone: 'danger' as const }]
                : [])
            ]
          : []
      workspaceTools.push(
        {
          id: 'files',
          label: 'Files',
          icon: CioFiles,
          active: board.switcherPanelTabs.dockKindActive('files'),
          onSelect: () =>
            board.switcherPanelTabs.toggleDockPanel(
              'files',
              () => void board.openThreadFromSwitcher.openFiles()
            )
        },
        {
          id: 'diff',
          label: changeLabel,
          icon: CioDiff,
          active: board.switcherPanelTabs.dockKindActive('diff'),
          ...(hasRecordedChanges ? { flyout: changeSummaryFlyout } : {}),
          ...(changeText.length > 0 ? { countText: changeText } : {}),
          onSelect: () =>
            board.switcherPanelTabs.toggleDockPanel('diff', board.openThreadFromSwitcher.openDiff)
        }
      )
    }
    if (!isConversation && workspaceState.terminalAvailable) {
      if (!selectedThread.settings?.ovenId || selectedThread.settings.ovenId === 'local')
        workspaceTools.push({
          id: 'terminal',
          label: board.state.terminalOpen ? 'Hide terminal' : 'Show terminal',
          icon: CioTerminal,
          active: board.state.terminalOpen,
          onSelect: board.openThreadFromSwitcher.toggleTerminal
        })
      const runningActions = projectActionsState.runningCount(selectedThread.projectId)
      workspaceTools.push({
        id: 'actions',
        label: runningActions > 0 ? `Actions (${runningActions} running)` : 'Actions',
        icon: CioActions,
        active: board.switcherPanelTabs.dockKindActive('actions'),
        countBadge: runningActions > 0 ? String(runningActions) : undefined,
        countBadgeTone: runningActions > 0 ? 'working' : undefined,
        onSelect: () =>
          board.switcherPanelTabs.toggleDockPanel(
            'actions',
            board.openThreadFromSwitcher.openActionsTab
          )
      })
    }

    const sessionTools: ContextDockItem[] = [
      {
        id: 'sources',
        label:
          workspaceState.sourceProcessCount > 0
            ? `Sources (${workspaceState.sourceProcessCount} ${workspaceState.sourceProcessCount === 1 ? 'process' : 'processes'} running)`
            : 'Sources',
        icon: CioTabInfo,
        active: board.switcherPanelTabs.dockKindActive('sources'),
        countBadge:
          workspaceState.sourceProcessCount > 0
            ? String(workspaceState.sourceProcessCount)
            : undefined,
        onSelect: () =>
          board.switcherPanelTabs.toggleDockPanel(
            'sources',
            board.openThreadFromSwitcher.openSourcesTab
          )
      },
      {
        id: 'memory',
        label: 'Memory',
        icon: CioMemory,
        active: board.switcherPanelTabs.dockKindActive('memory'),
        badge: memoryProposalState.hasPending ? 'attention' : undefined,
        badgeTitle: `${memoryProposalState.pendingCount} memory proposals need attention`,
        onSelect: () =>
          board.switcherPanelTabs.toggleDockPanel(
            'memory',
            board.openThreadFromSwitcher.openMemoryTab
          )
      }
    ]
    if (!isConversation) {
      sessionTools.push({
        id: 'cloud-deployment',
        label: 'Cloud deployments',
        icon: CioCloud,
        active: board.switcherPanelTabs.dockKindActive('cloud-deployment'),
        onSelect: () =>
          board.switcherPanelTabs.toggleDockPanel(
            'cloud-deployment',
            board.openThreadFromSwitcher.openCloudDeploymentsTab
          )
      })
    }
    if (import.meta.env.DEV) {
      sessionTools.push({
        id: 'debugger',
        label: 'Debugger',
        icon: CioDebugger,
        active: board.switcherPanelTabs.dockKindActive('debugger'),
        onSelect: () =>
          board.switcherPanelTabs.toggleDockPanel(
            'debugger',
            board.openThreadFromSwitcher.openDebugger
          )
      })
    }

    // Temporary chats get their own hairline-separated slot: they are ephemeral
    // side conversations, not standing tools, and one button toggles the whole
    // set because the panel tabs them. The dashed mark names the tool; the mark
    // it carries is the set's own unread state, because a response that landed
    // while the panel was closed or parked on another tab has nowhere else to
    // surface.
    const temporaryChats: ContextDockItem[] = []
    if (board.temporaryChatTabs.temporaryChatTabs.length > 0) {
      const name =
        board.temporaryChatTabs.temporaryChatTabs.length === 1
          ? (board.temporaryChatTabs.temporaryChatTabs.at(-1)?.title ?? 'Quick chat')
          : `${board.temporaryChatTabs.temporaryChatTabs.length} quick chats`
      const unreadChats = board.temporaryChatTabs.unreadTemporaryChats.length
      temporaryChats.push({
        id: 'temporary-chat',
        label: board.switcherPanelTabs.dockKindActive('temporary-chat')
          ? `Hide ${name}`
          : `Show ${name}`,
        icon: CioTemporaryChat,
        active: board.switcherPanelTabs.dockKindActive('temporary-chat'),
        ...(unreadChats > 0
          ? {
              badgeColor: 'var(--color-thread-unread)',
              badgeTitle:
                unreadChats === 1
                  ? '1 quick chat has a response you have not read'
                  : `${unreadChats} quick chats have responses you have not read`
            }
          : {}),
        onSelect: () =>
          board.switcherPanelTabs.toggleDockPanel(
            'temporary-chat',
            board.temporaryChatTabs.focusTemporaryChat
          )
      })
    }

    // The coordinator sits alone at the bottom, below its own hairline: it is
    // the thread's own supervision surface, not a general workspace tool.
    //
    // A thread with no session still offers the project's own designs and videos.
    // The work belongs to the project, not to the thread the user happens to be
    // on, so the entry is there whether or not a session is open and opens the
    // board for the kind it names.
    const authoredWork: ContextDockItem[] = []
    if (selectedThread) {
      const work = projectWorkState.stateFor(selectedThread.projectId, selectedThread.id)
      for (const kind of ['design', 'video'] as const) {
        const session = designCoordinatorState.stateFor(selectedThread.projectId, selectedThread.id)
        const sessionKind = session?.active ? session.kind : undefined
        if ((work?.[kind].length ?? 0) === 0 && sessionKind !== kind) continue
        authoredWork.push({
          id: `authored-work-${kind}`,
          label: `${AUTHORED_WORK_NAME_BY_KIND[kind]}s in ${authoredWorkOwnerLabel(selectedThread.projectId)}`,
          icon: AUTHORED_WORK_ICON_BY_KIND[kind],
          active: board.openThreadFromSwitcher.authoredWorkActive(kind),
          media: browserAudio.boardActivities(selectedThread.id, kind),
          onSelect: () => board.openThreadFromSwitcher.openAuthoredWork(kind)
        })
      }
    }
    const coordination: ContextDockItem[] =
      board.openThreadFromSwitcher.coordinator &&
      board.openThreadFromSwitcher.coordinator.panel.component !== 'design'
        ? [
            {
              id: 'coordinator',
              label: board.openThreadFromSwitcher.coordinator.label,
              icon: board.openThreadFromSwitcher.coordinator.icon,
              active: board.switcherPanelTabs.dockKindActive('coordinator'),
              badge: board.openThreadFromSwitcher.coordinatorRailBadge,
              badgeTitle: board.switcherPanelTabs.coordinatorRailBadgeTitle,
              onSelect: () =>
                board.switcherPanelTabs.toggleDockPanel(
                  'coordinator',
                  board.openThreadFromSwitcher.openCoordinatorTab
                )
            },
            ...authoredWork
          ]
        : authoredWork

    // The thread-note indicator sits below its own hairline. It's always
    // present   not just once a note exists   so it also doubles as the "add a
    // note" entry point; the amber tone only kicks in once there's something
    // written to draw attention to.
    const hasThreadNote = threadNotesState.has(selectedThread.id)
    const threadNote: ContextDockItem[] = [
      {
        id: 'note',
        label: hasThreadNote
          ? `${feature('thread-note').name} available`
          : `Add a ${feature('thread-note').name.toLowerCase()}`,
        icon: feature('thread-note').icon,
        active: board.switcherPanelTabs.dockKindActive('thread-note'),
        tone: hasThreadNote ? 'warning' : undefined,
        onSelect: () =>
          board.switcherPanelTabs.toggleDockPanel('thread-note', () =>
            contextSidebarState.openThreadNote(
              selectedThread.projectId,
              selectedThread.id,
              selectedThread.title
            )
          )
      }
    ]
    if (board.state.browserTabs.length > 0) {
      const name =
        board.state.browserTabs.length === 1
          ? (board.state.browserTabs.at(-1)?.title ?? 'Browser')
          : `${board.state.browserTabs.length} browser tabs`
      threadNote.push({
        id: 'browser',
        label: board.switcherPanelTabs.dockKindActive('browser') ? `Hide ${name}` : `Show ${name}`,
        icon: CioThreadBrowser,
        active: board.switcherPanelTabs.dockKindActive('browser'),
        media: [
          ...new SvelteSet(
            board.state.browserTabs.flatMap((tab) => {
              const runtime = contextSidebarState.browserRuntime(tab.id)
              return [
                ...captureActivities(runtime),
                ...(runtime.audible && !runtime.muted ? ['audio' as const] : [])
              ]
            })
          )
        ],
        playing: board.state.browserTabs.some((tab) => {
          const runtime = contextSidebarState.browserRuntime(tab.id)
          return runtime.audible && !runtime.muted
        }),
        countBadge:
          board.switcherPanelTabs.browser.unfinishedDownloadCount > 0
            ? String(board.switcherPanelTabs.browser.unfinishedDownloadCount)
            : undefined,
        menu: board.switcherPanelTabs.browser.menuOpen ? browserMenu : undefined,
        onSelect: () => {
          board.switcherPanelTabs.browser.menuOpen = false
          board.switcherPanelTabs.toggleDockPanel('browser', board.state.focusBrowser)
        },
        onContextMenu: board.switcherPanelTabs.browser.openContextMenu
      })
    }

    // Sub-agents appear only after the first one is opened. The group shares
    // one toggle, while the sidebar keeps each sub-agent in its own tab. The Bot
    // glyph is what marks a sub-agent; no rail colour does.
    const subagents: ContextDockItem[] = []
    if (board.focusSubagent.subagentTabs.length > 0) {
      const name =
        board.focusSubagent.subagentTabs.length === 1
          ? (board.focusSubagent.subagentTabs.at(-1)?.title ?? 'Sub-agent')
          : `${board.focusSubagent.subagentTabs.length} sub-agents`
      subagents.push({
        id: 'subagent',
        label: board.switcherPanelTabs.dockKindActive('subagent') ? `Hide ${name}` : `Show ${name}`,
        icon: CioSubagent,
        active: board.switcherPanelTabs.dockKindActive('subagent'),
        onSelect: () =>
          board.switcherPanelTabs.toggleDockPanel('subagent', board.focusSubagent.focusSubagent)
      })
    }

    // Auto-resolved gates sit at the very bottom of the rail: they are the
    // app's own record of what it decided while the user was away, not a
    // workspace tool. The item is keyed to the open conversation, so it appears
    // only on the thread a decision concerns (or on its task, or on any thread
    // of its assistant), and disappears once that scope has nothing unread.
    const attentionScope = selectedThread
      ? {
          id: selectedThread.id,
          projectId: selectedThread.projectId,
          ...(selectedThread.assistantId ? { assistantId: selectedThread.assistantId } : {}),
          ...(selectedThread.assistantTaskId
            ? { assistantTaskId: selectedThread.assistantTaskId }
            : {})
        }
      : null
    const attentionItems = attentionScope ? attentionState.unreadFor(attentionScope) : []
    const autoAnswerTools: ContextDockItem[] =
      selectedThread && attentionItems.length > 0
        ? [
            {
              id: 'attention',
              label: 'Decisions made for you',
              icon: CioAttention,
              tone: 'warning',
              countBadge: String(attentionItems.length),
              active: board.switcherPanelTabs.dockKindActive('attention'),
              onSelect: () =>
                board.switcherPanelTabs.toggleDockPanel('attention', () =>
                  contextSidebarState.openAttention(selectedThread.projectId, selectedThread.id)
                )
            }
          ]
        : []

    return [
      history,
      assistantTools,
      workspaceTools,
      sessionTools,
      temporaryChats,
      coordination,
      threadNote,
      subagents,
      autoAnswerTools
    ]
  })

  /**
   * The selected thread and project, held locally because the markup narrows them
   * inside an `{#if}` and a narrowed property access does not survive the callback
   * Svelte compiles that branch into.
   */
  const selectedThread = $derived(board.openThreadFromSwitcher.selectedThread)
  const activeProject = $derived(board.openThreadFromSwitcher.activeProject)
</script>

<svelte:document onpointerdowncapture={board.switcherPanelTabs.handleComposerPointerDown} />

<div class="flex h-full">
  <!-- Shared board.switcherPanelTabs.sidebar   Projects/Chats/Threads use WorkspaceSidebar; Assistant has its own.
       A view with nothing in its board.switcherPanelTabs.sidebar paints no board.switcherPanelTabs.sidebar at all, so an empty
       panel is never put in front of the user. -->
  {#if board.markThreadReadAndApply.workspaceSidebarVisible && board.props.mode === 'assistant'}
    {#await import('../assistant/AssistantSidebar.svelte') then { default: AssistantSidebar }}
      <AssistantSidebar
        bind:scroller={board.switcherPanelTabs.sidebarScroller}
        assistants={board.mergeThreadsInList.assistantList}
        tasks={board.markThreadReadAndApply.assistantTasks}
        runsByTask={board.mergeThreadsInList.assistantRunsByTask}
        runsByAssistant={board.mergeThreadsInList.runsByAssistant}
        selectedThreadId={activeThreadRowId(selectedThread)}
        onOpenTask={board.markThreadReadAndApply.openAssistantTask}
        onOpenTaskKnowledge={board.mergeThreadsInList.openAssistantKnowledgeForTask}
        onOpenAssistantKnowledge={(assistant) =>
          void board.markThreadReadAndApply.openAssistantKnowledgeFor(assistant)}
        onCreateTaskInAssistant={(assistant) =>
          void board.mergeThreadsInList.createTaskInAssistant(assistant)}
        onRenameTask={board.switcherPanelTabs.handleRename}
        onTogglePinTask={(task) => void board.openThreadFromSwitcher.togglePin(task)}
        onDeleteTask={board.switcherPanelTabs.handleDelete}
        onForkTask={(task) => void board.switcherPanelTabs.forkThread(task)}
        onOpenTaskNotes={board.switcherPanelTabs.openAssistantTaskNotes}
        onHandedOffTask={board.switcherPanelTabs.handleAssistantHandoff}
        onHideKnowledge={(task) => void board.switcherPanelTabs.hideAssistantKnowledge(task)}
        onDeleteAssistant={board.mergeThreadsInList.deleteAssistant}
        onHasAssistantRunsToday={(assistant) => assistants.hasRunsToday(assistant.id)}
        onSkipNextAssistantRun={board.state.skipNextRun}
        onSkipAssistantRunsToday={board.state.skipRunsToday}
        onTogglePinAssistant={(assistant) => void board.state.toggleAssistantPin(assistant)}
        onMoveAssistant={(draggedId, targetId, position) =>
          void board.state.moveAssistant(draggedId, targetId, position)}
        onAssignTask={(taskId, assistantId) =>
          void board.mergeThreadsInList.assignAssistantTask(taskId, assistantId)}
      />
    {/await}
  {:else if board.markThreadReadAndApply.workspaceSidebarVisible}
    <WorkspaceSidebar
      bind:scroller={board.switcherPanelTabs.sidebarScroller}
      mode={board.props.mode}
      active={board.props.active}
      projects={board.createThreadInProject.projects}
      visibleProjects={board.mergeThreadsInList.visibleProjects}
      projectIcons={board.createThreadInProject.projectIcons}
      loading={board.switcherPanelTabs.loading}
      activeThreadId={activeThreadRowId(selectedThread)}
      threadsByProject={board.markThreadReadAndApply.threadsByProject}
      pinnedThreads={board.markThreadReadAndApply.pinnedThreads}
      pinnedProjects={board.markThreadReadAndApply.pinnedProjects}
      regularProjects={board.mergeThreadsInList.regularProjects}
      pinnedInboxThreads={board.markThreadReadAndApply.pinnedInboxThreads}
      standaloneThreads={board.markThreadReadAndApply.standaloneThreads}
      pinnedTimelineThreads={board.mergeThreadsInList.pinnedTimelineThreads}
      unpinnedTimelineThreads={board.switcherPanelTabs.unpinnedTimelineThreads}
      draftThreadKeys={board.markThreadReadAndApply.draftThreadKeys}
      typingThreadKeys={board.markThreadReadAndApply.typingThreadKeys}
      hasMoreHistory={board.mergeThreadsInList.hasMoreHistory}
      historyLoading={board.switcherPanelTabs.historyLoading}
      projectPageLoading={board.switcherPanelTabs.projectPageLoading}
      sidebar={board.switcherPanelTabs.sidebar}
      projectDialogs={board.createThreadInProject.projectDialogs}
      scopeActions={board.state.scopeActions}
      projectHasMoreInDb={board.switcherPanelTabs.projectHasMoreInDb}
      onLoadProjectThreadsPage={board.createThreadInProject.loadProjectThreadsPage}
      onLoadHistoryPage={board.createThreadInProject.loadHistoryPage}
      onSetProjects={(next: Project[]) => (board.createThreadInProject.projects = next)}
      onOpenThread={board.openThreadFromSwitcher.openThread}
      onRename={board.switcherPanelTabs.handleRename}
      onTogglePin={board.openThreadFromSwitcher.togglePin}
      onDelete={board.switcherPanelTabs.handleDelete}
      onFork={board.switcherPanelTabs.forkThread}
      onThreadDrop={board.mergeThreadsInList.handleThreadDrop}
      onPinnedThreadMove={board.markThreadReadAndApply.handlePinnedThreadMove}
      onTimelinePinnedMove={board.mergeThreadsInList.handleTimelinePinnedMove}
      onProjectMove={board.mergeThreadsInList.handleProjectMove}
      onCreateThread={board.createThreadInProject.createThreadInProject}
      onOpenScopedThread={board.switcherPanelTabs.openScopedThread}
      onSwitchScopedProject={board.mergeThreadsInList.switchScopedProject}
    />
  {/if}

  <!-- Main Content. `overflow-clip`, not `overflow-hidden`: hidden is still a
       scroll container, and a panel sliding in on `fly` translates past this
       box, which grows the scrollable area. A focused control inside the
       arriving panel (the terminal is the one that focuses itself) then
       scrolls the whole shell down and the scroll clamps back as the slide
       settles, so the thread visibly dropped and rose. Clip makes this box
       never scrollable, so nothing can move it. -->
  <section class="flex min-w-0 flex-1 overflow-clip">
    <div
      class="grid h-full min-h-0 min-w-0 flex-1"
      style:grid-template-columns={board.contextPanelColumns.contextPanelColumns}
      style:grid-template-rows={board.contextPanelRows.contextPanelRows}
      style:--context-rail-width={board.panelExitMs.railTrackWidth}
      style:transition-property="--context-rail-width"
      style:transition-timing-function="cubic-bezier(0.215, 0.61, 0.355, 1)"
      style:transition-duration={board.panelExitMs.railTrackDuration}
    >
      <WorkspaceConversationPane
        mode={board.props.mode}
        active={board.props.active}
        {selectedThread}
        visibleProjects={board.mergeThreadsInList.visibleProjects}
        projectIcons={board.createThreadInProject.projectIcons}
        threadsByProject={board.markThreadReadAndApply.threadsByProject}
        config={board.props.config}
        updateConfig={board.props.updateConfig}
        restoreKey={board.markThreadReadAndApply.chatsComposerRestoreKey}
        sidebarHasContent={board.markThreadReadAndApply.workspaceSidebarHasContent}
        assistantForeignRunThreadId={board.mergeThreadsInList.selectedAssistantForeignRunThreadId}
        onNavigate={board.props.navigate}
        onForked={board.switcherPanelTabs.handleForkedThread}
        onContinueInProject={board.switcherPanelTabs.handleContinuedInProject}
        onProjectCreated={board.switcherPanelTabs.handleChatProjectCreated}
        onOpenScopeView={(thread) => void board.openThreadScopeView.openThreadScopeView(thread)}
        onOpenAssistantThread={board.markThreadReadAndApply.openAssistantTask}
        onSendChat={board.markThreadReadAndApply.createStandaloneChat}
        onStartChatDraft={board.markThreadReadAndApply.startChatDraft}
        onRequestAddProject={(kind) => {
          board.state.projectCreateTriggerKind = kind
          workspaceState.requestAddProject()
        }}
      />

      {#if board.panelExitMs.sidebarVisible || board.state.sidebarHostsFullscreenEditor}
        {#snippet contextSidebarContent()}
          <WorkspaceContextPanelContent
            active={board.props.active}
            gitPanelProjectId={board.state.gitPanelProjectId}
            gitPanelScopeBucketId={board.state.gitPanelScopeBucketId}
            gitPanelVisible={board.openThreadFromSwitcher.gitPanelVisible}
            terminalFullscreenTabId={board.openThreadFromSwitcher.terminalFullscreenTabId}
            browserFullscreenTabId={board.openThreadFromSwitcher.browserFullscreenTabId}
            {activeProject}
            {selectedThread}
            projectIcons={board.createThreadInProject.projectIcons}
            browser={board.switcherPanelTabs.browser}
            onDismissCoordinator={() => {
              const tab = contextSidebarState.sidebarActiveTab
              if (tab?.kind === 'coordinator') board.openThreadFromSwitcher.closeContextTab(tab.id)
            }}
            onContinueInThread={board.switcherPanelTabs.handleContinueInThread}
            onOpenSubagent={board.openThreadFromSwitcher.openNestedSubagent}
            navigate={board.props.navigate}
            onOpenAssistantTask={board.markThreadReadAndApply.openAssistantTask}
            onSetupAssistantConnection={board.mergeThreadsInList.openAssistantConnectionSetup}
            onAdoptAssistantTask={board.mergeThreadsInList.requestTaskOwnerForTask}
          />
        {/snippet}
        <div
          class="min-h-0 min-w-0 {board.appBackgroundPanelKinds.rightSidebarFlushes
            ? 'border-l border-border'
            : ''}"
          style:grid-column="2"
          style:grid-row="1"
          style:visibility={board.panelExitMs.guideHidesToolPanel ? 'hidden' : 'visible'}
          in:fly={{ x: contextSidebarState.width, duration: motionDuration(200), easing: cubicOut }}
          out:fly={{
            x: contextSidebarState.width,
            duration: motionDuration(board.panelExitMs.PANEL_EXIT_MS),
            easing: cubicOut
          }}
        >
          <div
            class="h-full min-h-0"
            {@attach board.props.active &&
            contextSidebarState.sidebarActiveTab?.kind === 'temporary-chat'
              ? fullscreenFileChatHost
              : undefined}
          >
            <ContextSidebar
              tabs={contextSidebarState.sidebarTabs}
              activeTabId={contextSidebarState.sidebarActiveTabId}
              width={contextSidebarState.width}
              height={contextSidebarState.terminalHeight}
              placement="right"
              content={contextSidebarContent}
              tabPresentation={board.mergeThreadsInList.tabPresentation}
              onSelect={(id) => contextSidebarState.focus(id)}
              onClose={board.openThreadFromSwitcher.closeContextTab}
              onFullscreenTab={board.openThreadFromSwitcher.openTabFullscreen}
              onMoveTab={(id, targetId, position) =>
                contextSidebarState.reorder(id, targetId, position)}
              onWidthChange={(width) => board.panelExitMs.handleRailWidthChange(width)}
              onHeightChange={(height) => contextSidebarState.setTerminalHeight(height)}
              onTerminalPlacementChange={(placement) =>
                contextSidebarState.setTerminalPlacement(placement)}
              onNewTerminal={board.openThreadFromSwitcher.openNewTerminal}
              onNewBrowser={() => board.openThreadFromSwitcher.openNewBrowserTab()}
              onTabContextMenu={(id, event) =>
                void board.switcherPanelTabs.browser.openTabMenu(
                  id,
                  event,
                  board.openThreadFromSwitcher.closeContextTab
                )}
            />
          </div>
        </div>
      {/if}
      {#if board.state.terminalDockVisible}
        {#snippet terminalDockContent()}
          <WorkspaceTerminalDockContent
            terminalFullscreenTabId={board.openThreadFromSwitcher.terminalFullscreenTabId}
          />
        {/snippet}
        <div
          class="min-h-0 min-w-0"
          style:grid-column="1 / -1"
          style:grid-row="2"
          in:fly={{
            y: contextSidebarState.terminalHeight,
            duration: motionDuration(200),
            easing: cubicOut
          }}
          out:fly={{
            y: contextSidebarState.terminalHeight,
            duration: motionDuration(board.panelExitMs.PANEL_EXIT_MS),
            easing: cubicOut
          }}
        >
          <ContextSidebar
            tabs={contextSidebarState.terminalTabs}
            activeTabId={contextSidebarState.terminalActiveTabId}
            width={contextSidebarState.width}
            height={contextSidebarState.terminalHeight}
            placement="bottom"
            content={terminalDockContent}
            onSelect={(id) => contextSidebarState.focus(id)}
            onClose={board.openThreadFromSwitcher.closeContextTab}
            onFullscreenTab={board.openThreadFromSwitcher.openTabFullscreen}
            onMoveTab={(id, targetId, position) =>
              contextSidebarState.reorder(id, targetId, position)}
            onWidthChange={(width) => contextSidebarState.setWidth(width)}
            onHeightChange={(height) => contextSidebarState.setTerminalHeight(height)}
            onTerminalPlacementChange={(placement) =>
              contextSidebarState.setTerminalPlacement(placement)}
            onTerminalDockToggle={() => contextSidebarState.toggleTerminalDock()}
            onNewTerminal={board.openThreadFromSwitcher.openNewTerminal}
          />
        </div>
      {/if}
    </div>
    {#if dockGroups.some((group) => group.length > 0)}
      <ContextDock groups={dockGroups} />
    {/if}
  </section>
</div>

{#snippet historyMenu()}
  <WorkspaceHistoryMenu
    onClose={() => (board.jumpToHistoryMessage.showHistoryMenu = false)}
    onSelect={board.jumpToHistoryMessage.jumpToHistoryMessage}
  />
{/snippet}

{#snippet browserMenu()}
  {#await import('./WorkspaceBrowserMenu.svelte') then { default: WorkspaceBrowserMenu }}
    <WorkspaceBrowserMenu browser={board.switcherPanelTabs.browser} />
  {/await}
{/snippet}

<!-- The Changes rail item's hover preview: the current change set's line totals
     and file count. The store tracked for the on-screen thread feeds it. -->
{#snippet changeSummaryFlyout()}
  <ChangeSummaryFlyout />
{/snippet}

<!-- Global-board.switcherPanelTabs.browser surfaces wait for `browserStore()` so their chunks are not
     fetched on a launch that never reaches the board.switcherPanelTabs.browser. Thread-board.switcherPanelTabs.browser
     fullscreen is loaded separately below when a thread tab asks for it. -->
{#if browserStore()}
  {#await import('./WorkspaceBrowserDataModal.svelte') then { default: WorkspaceBrowserDataModal }}
    <WorkspaceBrowserDataModal
      browser={board.switcherPanelTabs.browser}
      projects={board.createThreadInProject.projects}
    />
  {/await}

  {#await import('./WorkspaceBrowserDownloadsModal.svelte') then { default: WorkspaceBrowserDownloadsModal }}
    <WorkspaceBrowserDownloadsModal browser={board.switcherPanelTabs.browser} />
  {/await}
{/if}

<!-- A new thread with no project open has no project to belong to yet, so the
     header's new-thread action (and Cmd/Ctrl+N) asks with the same project
     selector the chat hand-off uses. The chosen project mints the empty thread. -->
<ContinueInProjectModal
  open={board.newThreadPicker.open}
  title="New thread in a project"
  description="Choose the project this thread belongs to. It opens empty, ready for your first message."
  confirmLabel="Create thread"
  projects={board.newThreadPicker.projects}
  projectIcons={board.newThreadPicker.projectIcons}
  busy={board.newThreadPicker.busy}
  onClose={board.newThreadPicker.close}
  onContinue={(project) => void board.newThreadPicker.pick(project)}
  onProjectCreated={(project) => void board.newThreadPicker.projectCreated(project)}
/>

<WorkspaceRemoveProjectModals dialogs={board.createThreadInProject.projectDialogs} />

<WorkspaceEditProjectModal
  dialogs={board.createThreadInProject.projectDialogs}
  projectIcons={board.createThreadInProject.projectIcons}
/>

<ThreadSwitcher
  entries={board.switcherPanelTabs.recentSwitcherEntries}
  projects={board.mergeThreadsInList.visibleProjects}
  projectIconUrls={board.createThreadInProject.projectIcons}
  selectedKey={board.switcherPanelTabs.switcherSelectedKey}
  onSelect={board.openThreadFromSwitcher.openSwitcherEntry}
/>

{#if board.switcherPanelTabs.terminalFullscreenTab}
  {#await import('./WorkspaceFullscreenTerminal.svelte') then { default: WorkspaceFullscreenTerminal }}
    <WorkspaceFullscreenTerminal
      tabId={board.openThreadFromSwitcher.terminalFullscreenTabId}
      onTabIdChange={(id) => (board.openThreadFromSwitcher.terminalFullscreenTabId = id)}
      onNewTerminal={board.openThreadFromSwitcher.openNewTerminal}
      onCloseTab={(id) => board.openThreadFromSwitcher.closeFullscreenTab('terminal', id)}
    />
  {/await}
{/if}
{#if board.openThreadFromSwitcher.browserFullscreenTabId}
  {#await import('./WorkspaceFullscreenBrowser.svelte') then { default: WorkspaceFullscreenBrowser }}
    <WorkspaceFullscreenBrowser
      tabId={board.openThreadFromSwitcher.browserFullscreenTabId}
      onTabIdChange={(id) => (board.openThreadFromSwitcher.browserFullscreenTabId = id)}
      onNewBrowser={() => board.openThreadFromSwitcher.openNewBrowserTab()}
      onTabContextMenu={(id, event) =>
        void board.switcherPanelTabs.browser.openTabMenu(
          id,
          event,
          board.openThreadFromSwitcher.closeContextTab
        )}
      onCloseTab={(id) => board.openThreadFromSwitcher.closeFullscreenTab('browser', id)}
    />
  {/await}
{/if}

<!-- Closing a files tab with unsaved changes -->
<WorkspaceUnsavedChangesDialog
  target={board.switcherPanelTabs.closeTabTarget}
  onCancel={() => (board.switcherPanelTabs.closeTabTarget = null)}
  onDiscard={board.switcherPanelTabs.discardCloseTab}
  onSave={board.switcherPanelTabs.saveAndCloseTab}
/>

<!-- Which assistant takes on a task. Nothing in the Assistant view runs without
     one, so this is the question every task with no owner is answered with. -->
<AssistantOwnerPicker
  open={board.mergeThreadsInList.taskOwnerRequest !== null}
  assistants={board.mergeThreadsInList.assistantList}
  question={board.mergeThreadsInList.taskOwnerRequest?.mode === 'assign'
    ? `Who should take on “${board.mergeThreadsInList.taskOwnerRequest.taskLabel ?? 'this task'}”?`
    : 'Which assistant should this task belong to?'}
  onPick={(assistantId) => void board.mergeThreadsInList.pickTaskOwner(assistantId)}
  onNewAssistant={() => {
    board.mergeThreadsInList.taskOwnerRequest = null
    board.mergeThreadsInList.assistantCreateTrigger++
  }}
  onClose={() => (board.mergeThreadsInList.taskOwnerRequest = null)}
/>
