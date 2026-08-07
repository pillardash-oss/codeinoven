<script lang="ts">
  import { invoke } from '$lib/ipc.svelte'
  import {
    INBOX_PROJECT_ID,
    type MemoryCategory,
    type MemoryEntry,
    type MemoryPriority,
    type MemoryProposal,
    type MemoryScope
  } from '$shared/types'
  import MemoryEntryComponent from './MemoryEntry.svelte'
  import Switch from '../ui/Switch.svelte'
  import { memoryProposalState } from '$lib/stores/memory-proposals.svelte'
  import { Check, Loader2, Plus, Save, Search, X } from '@lucide/svelte'

  interface Props {
    variant?: 'settings' | 'sidebar'
    /** The active settings tab — 'projects' or 'chats'. */
    scope?: 'projects' | 'chats'
    projectId?: string
    threadId?: string
    memoryEnabled?: boolean
    chatMemoryEnabled?: boolean
    onMemoryEnabledChange?: (enabled: boolean) => Promise<void>
    onChatMemoryEnabledChange?: (enabled: boolean) => Promise<void>
    activeSection?: MemorySection
  }

  interface PendingProposal {
    proposal: MemoryProposal
    queueProjectId?: string
  }

  type MemorySection = 'active' | 'proposed'

  type MemoryTab = 'projects' | 'chats'

  let {
    variant = 'settings',
    scope = $bindable('projects'),
    projectId,
    threadId,
    memoryEnabled,
    chatMemoryEnabled,
    onMemoryEnabledChange,
    onChatMemoryEnabledChange,
    activeSection = $bindable('active')
  }: Props = $props()

  let entries = $state<MemoryEntry[]>([])
  let proposals = $state<PendingProposal[]>([])
  let loading = $state(true)
  let saving = $state(false)
  let saved = $state(false)
  let error = $state('')
  let loadedProjectEnabled = $state(true)
  let loadedChatEnabled = $state(true)
  let proposalBusyIds = $state<string[]>([])
  let loadRequest = 0
  let searchQuery = $state('')
  let filterCategory = $state<MemoryCategory | ''>('')
  let filterPriority = $state<MemoryPriority | ''>('')
  let settingsSection = $state<'active' | 'inactive'>('active')

  const categoryLabels: Record<MemoryCategory, string> = {
    behavioral: 'Behavioral',
    'project-rule': 'Project Rule',
    identity: 'Identity',
    preference: 'Preference'
  }

  const priorityLabels: Record<MemoryPriority, string> = {
    critical: 'Critical',
    high: 'High',
    medium: 'Medium',
    low: 'Low'
  }

  /** Whether this panel is managing project memory or chat memory. */
  let contextKind = $derived<MemoryTab>(
    variant === 'settings' ? scope : projectId === INBOX_PROJECT_ID ? 'chats' : 'projects'
  )

  let effectiveMemoryEnabled = $derived(
    contextKind === 'chats'
      ? (chatMemoryEnabled ?? loadedChatEnabled)
      : (memoryEnabled ?? loadedProjectEnabled)
  )

  let headerDescription = $derived(
    variant === 'settings'
      ? scope === 'chats'
        ? 'Memory that applies to standalone chats. Global preferences are shared with projects.'
        : 'Memory that applies to project work. Global preferences are shared with chats.'
      : projectId === INBOX_PROJECT_ID
        ? 'Global, chat, and thread preferences active in this conversation.'
        : 'Global, project, and thread preferences active in this conversation.'
  )

  let availableScopes = $derived.by((): Array<{ value: MemoryScope; label: string }> => {
    if (variant === 'settings') {
      return scope === 'chats'
        ? [
            { value: 'global', label: 'Global' },
            { value: 'chat', label: 'Chats' }
          ]
        : [
            { value: 'global', label: 'Global' },
            { value: 'projects', label: 'Projects' }
          ]
    }
    if (projectId === INBOX_PROJECT_ID) {
      return [
        { value: 'global', label: 'Global' },
        { value: 'chat', label: 'Chats' },
        { value: 'thread', label: 'Thread' }
      ]
    }
    return [
      { value: 'global', label: 'Global' },
      { value: 'projects', label: 'Projects' },
      { value: 'project', label: 'Specific project' },
      { value: 'thread', label: 'Thread' }
    ]
  })

  let currentSection = $derived(variant === 'settings' ? settingsSection : activeSection)
  let inactiveCount = $derived(entries.filter((entry) => !entry.enabled).length)

  let sectionEntries = $derived(
    variant === 'settings'
      ? currentSection === 'active'
        ? entries.filter((entry) => entry.enabled)
        : entries.filter((entry) => !entry.enabled)
      : entries
  )

  let filteredEntries = $derived.by(() => {
    let result = sectionEntries
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (e) => e.label.toLowerCase().includes(q) || e.content.toLowerCase().includes(q)
      )
    }
    if (filterCategory) {
      result = result.filter((e) => e.category === filterCategory)
    }
    if (filterPriority) {
      result = result.filter((e) => e.priority === filterPriority)
    }
    return result
  })

  let stats = $derived({
    total: sectionEntries.length,
    enabled: sectionEntries.filter((e) => e.enabled).length,
    autoDetected: sectionEntries.filter((e) => e.source === 'auto-detected').length
  })

  let emptyState = $derived.by((): { title: string; body: string } => {
    if (sectionEntries.length > 0) {
      return {
        title: 'No entries match your filters.',
        body: 'Try adjusting your search or filters.'
      }
    }
    if (variant === 'settings' && currentSection === 'inactive') {
      return {
        title: 'No inactive memories.',
        body: 'Memories you disable will appear here.'
      }
    }
    if (variant === 'settings') {
      return scope === 'chats'
        ? {
            title: 'No chat memories yet.',
            body: 'Add a preference you want chat agents to remember, or approve suggested ones.'
          }
        : {
            title: 'No project memories yet.',
            body: 'Explicit preferences are suggested for approval, or you can add one manually.'
          }
    }
    return {
      title: 'No memory entries yet.',
      body: 'Explicit preferences are suggested for approval, or you can add one manually.'
    }
  })

  async function load(): Promise<void> {
    const request = ++loadRequest
    loading = true
    error = ''
    try {
      const config = await invoke('config:get')
      loadedProjectEnabled = config.memory.enabled
      loadedChatEnabled = config.memory.chatEnabled
      let nextEntries: MemoryEntry[]
      let nextProposals: PendingProposal[]
      if (variant === 'settings') {
        if (scope === 'chats') {
          const [rootEntries, chatEntries, globalProposals, chatProposals] = await Promise.all([
            invoke('memory:getEntries'),
            invoke('memory:getEntries', INBOX_PROJECT_ID),
            invoke('memory:getPendingProposals'),
            invoke('memory:getPendingProposals', INBOX_PROJECT_ID)
          ])
          nextEntries = [...rootEntries.filter((entry) => entry.scope === 'global'), ...chatEntries]
          nextProposals = [
            ...globalProposals.map((proposal) => ({ proposal })),
            ...chatProposals.map((proposal) => ({ proposal, queueProjectId: INBOX_PROJECT_ID }))
          ]
        } else {
          nextEntries = await invoke('memory:getEntries')
          nextProposals = []
        }
      } else if (projectId === INBOX_PROJECT_ID) {
        const [rootEntries, chatEntries, threadEntries, globalProposals, chatProposals] =
          await Promise.all([
            invoke('memory:getEntries'),
            invoke('memory:getEntries', INBOX_PROJECT_ID),
            invoke('memory:getEntries', INBOX_PROJECT_ID, threadId),
            invoke('memory:getPendingProposals'),
            invoke('memory:getPendingProposals', INBOX_PROJECT_ID)
          ])
        nextEntries = [
          ...rootEntries.filter((entry) => entry.scope === 'global'),
          ...chatEntries,
          ...(threadId ? threadEntries : [])
        ]
        nextProposals = [
          ...globalProposals.map((proposal) => ({ proposal })),
          ...chatProposals.map((proposal) => ({ proposal, queueProjectId: INBOX_PROJECT_ID }))
        ]
      } else if (projectId && threadId) {
        const [globalEntries, projectEntries, threadEntries, globalProposals, projectProposals] =
          await Promise.all([
            invoke('memory:getEntries'),
            invoke('memory:getEntries', projectId),
            invoke('memory:getEntries', projectId, threadId),
            invoke('memory:getPendingProposals'),
            invoke('memory:getPendingProposals', projectId)
          ])
        nextEntries = [...globalEntries, ...projectEntries, ...threadEntries]
        nextProposals = [
          ...globalProposals.map((proposal) => ({ proposal })),
          ...projectProposals.map((proposal) => ({ proposal, queueProjectId: projectId }))
        ]
      } else {
        nextEntries = []
        nextProposals = []
      }
      if (request !== loadRequest) return
      entries = nextEntries
      proposals = nextProposals
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load memory entries.'
    } finally {
      if (request === loadRequest) loading = false
    }
  }

  async function save(): Promise<void> {
    saving = true
    error = ''
    saved = false
    try {
      if (variant === 'settings') {
        if (scope === 'chats') {
          const globalEntries = entries
            .filter((entry) => entry.scope === 'global')
            .map((entry) => withScope(entry, 'global'))
          const chatEntries = entries
            .filter((entry) => entry.scope === 'chat')
            .map((entry) => withScope(entry, 'chat'))
          await Promise.all([
            invoke('memory:saveEntries', globalEntries),
            invoke('memory:saveEntries', chatEntries, INBOX_PROJECT_ID)
          ])
        } else {
          await invoke(
            'memory:saveEntries',
            entries.map((entry) => withScope(entry, entry.scope))
          )
        }
      } else if (projectId === INBOX_PROJECT_ID) {
        const globalEntries = entries
          .filter((entry) => entry.scope === 'global')
          .map((entry) => withScope(entry, 'global'))
        const chatEntries = entries
          .filter((entry) => entry.scope === 'chat')
          .map((entry) => withScope(entry, 'chat'))
        const threadEntries = entries
          .filter((entry) => entry.scope === 'thread')
          .map((entry) => withScope(entry, 'thread'))
        await Promise.all([
          invoke('memory:saveEntries', globalEntries),
          invoke('memory:saveEntries', chatEntries, INBOX_PROJECT_ID),
          invoke('memory:saveEntries', threadEntries, INBOX_PROJECT_ID, threadId)
        ])
      } else if (projectId && threadId) {
        const rootEntries = entries
          .filter((entry) => entry.scope === 'global' || entry.scope === 'projects')
          .map((entry) => withScope(entry, entry.scope))
        const projectEntries = entries
          .filter((entry) => entry.scope === 'project')
          .map((entry) => withScope(entry, 'project'))
        const threadEntries = entries
          .filter((entry) => entry.scope === 'thread')
          .map((entry) => withScope(entry, 'thread'))
        await Promise.all([
          invoke('memory:saveEntries', rootEntries),
          invoke('memory:saveEntries', projectEntries, projectId),
          invoke('memory:saveEntries', threadEntries, projectId, threadId)
        ])
      } else {
        throw new Error('Open a project thread before editing scoped memory.')
      }
      saved = true
      await load()
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to save memory entries.'
    } finally {
      saving = false
    }
  }

  function withScope(entry: MemoryEntry, entryScope: MemoryScope): MemoryEntry {
    return {
      ...entry,
      scope: entryScope,
      projectId: entryScope === 'project' || entryScope === 'thread' ? projectId : undefined,
      threadId: entryScope === 'thread' ? threadId : undefined
    }
  }

  function addEntry(): void {
    const entryScope = availableScopes.at(-1)?.value ?? 'global'
    entries = [
      ...entries,
      {
        id: `memory-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        label: '',
        content: '',
        enabled: true,
        updatedAt: Date.now(),
        category: 'preference',
        priority: 'medium',
        scope: entryScope,
        source: 'manual',
        frequency: 1,
        lastReinforced: Date.now(),
        projectId: entryScope === 'project' || entryScope === 'thread' ? projectId : undefined,
        threadId: entryScope === 'thread' ? threadId : undefined
      }
    ]
  }

  async function setMemoryEnabled(enabled: boolean): Promise<void> {
    error = ''
    try {
      if (contextKind === 'chats') {
        if (onChatMemoryEnabledChange) {
          await onChatMemoryEnabledChange(enabled)
        } else {
          await invoke('config:update', {
            memory: { enabled: loadedProjectEnabled, chatEnabled: enabled, entries: [] }
          })
        }
        loadedChatEnabled = enabled
      } else {
        if (onMemoryEnabledChange) {
          await onMemoryEnabledChange(enabled)
        } else {
          await invoke('config:update', {
            memory: { enabled, chatEnabled: loadedChatEnabled, entries: [] }
          })
        }
        loadedProjectEnabled = enabled
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to update memory.'
    }
  }

  async function resolveProposal(row: PendingProposal, approve: boolean): Promise<void> {
    proposalBusyIds = [...proposalBusyIds, row.proposal.id]
    error = ''
    try {
      if (approve) {
        await invoke('memory:approveProposal', row.proposal.id, row.queueProjectId)
      } else {
        await invoke('memory:rejectProposal', row.proposal.id, row.queueProjectId)
      }
      await load()
      await memoryProposalState.refreshCurrent()
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to review memory proposal.'
    } finally {
      proposalBusyIds = proposalBusyIds.filter((id) => id !== row.proposal.id)
    }
  }

  function removeEntry(index: number): void {
    entries = entries.filter((_, i) => i !== index)
  }

  function updateEntry(
    index: number,
    field: keyof MemoryEntry,
    value: string | boolean | number
  ): void {
    entries = entries.map((entry, i) =>
      i === index ? { ...entry, [field]: value, updatedAt: Date.now() } : entry
    )
  }

  function showActive(): void {
    if (variant === 'settings') settingsSection = 'active'
    else activeSection = 'active'
  }

  function showInactive(): void {
    settingsSection = 'inactive'
  }

  function showProposed(): void {
    activeSection = 'proposed'
  }

  $effect(() => {
    const contextKey = `${variant}:${scope}:${projectId ?? ''}:${threadId ?? ''}`
    if (contextKey) void load()
  })
</script>

<div
  class="flex h-full min-h-0 flex-col {variant === 'settings'
    ? 'mx-auto w-full max-w-3xl p-6'
    : 'p-5'}"
>
  <!-- Fixed header: title, Projects/Chats tabs, enable toggle, section tabs -->
  <div class="shrink-0">
    <div class="mb-5 flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-bold tracking-tight">Memory</h1>
        <p class="mt-0.5 text-sm text-muted">{headerDescription}</p>
      </div>

      {#if variant === 'settings'}
        <div
          class="flex w-max items-center gap-0.5 rounded-lg border bg-elevated p-0.5"
          role="tablist"
          aria-label="Memory scope"
        >
          <button
            class="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors {scope ===
            'projects'
              ? 'bg-surface text-foreground shadow-sm'
              : 'text-muted hover:text-foreground'}"
            role="tab"
            aria-selected={scope === 'projects'}
            title="Manage project memory"
            onclick={() => (scope = 'projects')}
          >
            Projects
          </button>
          <button
            class="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors {scope ===
            'chats'
              ? 'bg-surface text-foreground shadow-sm'
              : 'text-muted hover:text-foreground'}"
            role="tab"
            aria-selected={scope === 'chats'}
            title="Manage chat memory"
            onclick={() => (scope = 'chats')}
          >
            Chats
          </button>
        </div>
      {/if}
    </div>

    {#if variant === 'settings'}
      <div class="mb-5 flex items-center justify-between gap-4 rounded-xl border bg-surface p-4">
        <div>
          <p class="text-sm font-medium text-foreground">
            Use persistent memory in {contextKind === 'chats' ? 'chats' : 'projects'}
          </p>
          <p class="mt-0.5 text-xs text-muted">
            When disabled, saved entries remain available here but are not sent to agents.
          </p>
        </div>
        <Switch
          checked={effectiveMemoryEnabled}
          onchange={() => void setMemoryEnabled(!effectiveMemoryEnabled)}
          aria-label={contextKind === 'chats'
            ? effectiveMemoryEnabled
              ? 'Disable persistent memory for chats'
              : 'Enable persistent memory for chats'
            : effectiveMemoryEnabled
              ? 'Disable persistent memory for projects'
              : 'Enable persistent memory for projects'}
          title={contextKind === 'chats'
            ? effectiveMemoryEnabled
              ? 'Disable persistent memory for chats'
              : 'Enable persistent memory for chats'
            : effectiveMemoryEnabled
              ? 'Disable persistent memory for projects'
              : 'Enable persistent memory for projects'}
        />
      </div>
    {:else if !effectiveMemoryEnabled}
      <p class="mb-4 rounded-lg bg-raised px-3 py-2 text-xs text-muted" role="status">
        Persistent memory is disabled{contextKind === 'chats' ? ' for chats' : ' for projects'}.
        Entries can be managed here but are not sent to agents.
      </p>
    {/if}

    {#if error}
      <p class="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
        {error}
      </p>
    {/if}

    {#if saved}
      <p class="mb-4 rounded-lg bg-primary/10 px-3 py-2 text-xs text-primary" role="status">
        Saved
      </p>
    {/if}

    <div
      class="mb-4 flex w-max items-center gap-0.5 rounded-lg border bg-elevated p-0.5"
      role="tablist"
      aria-label="Memory sections"
    >
      <button
        class="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors {currentSection ===
        'active'
          ? 'bg-surface text-foreground shadow-sm'
          : 'text-muted hover:text-foreground'}"
        role="tab"
        aria-selected={currentSection === 'active'}
        title="View active memory entries"
        onclick={showActive}
      >
        Active
      </button>
      {#if variant === 'settings'}
        <button
          class="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors {currentSection ===
          'inactive'
            ? 'bg-surface text-foreground shadow-sm'
            : 'text-muted hover:text-foreground'}"
          role="tab"
          aria-selected={currentSection === 'inactive'}
          title="View inactive memory entries"
          onclick={showInactive}
        >
          Inactive
          {#if inactiveCount > 0}
            <span
              class="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-primary"
            >
              {inactiveCount}
            </span>
          {/if}
        </button>
      {:else}
        <button
          class="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors {currentSection ===
          'proposed'
            ? 'bg-surface text-foreground shadow-sm'
            : 'text-muted hover:text-foreground'}"
          role="tab"
          aria-selected={currentSection === 'proposed'}
          title="Review proposed memory entries"
          onclick={showProposed}
        >
          Proposed
          {#if proposals.length > 0}
            <span
              class="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-primary"
            >
              {proposals.length}
            </span>
          {/if}
        </button>
      {/if}
    </div>
  </div>

  {#if currentSection === 'proposed'}
    <!-- Proposals list (scrollable) -->
    <div class="min-h-0 flex-1 overflow-y-auto pb-2">
      <section class="rounded-xl border bg-surface p-4" aria-labelledby="memory-proposals-title">
        <div class="mb-3">
          <h2 id="memory-proposals-title" class="text-sm font-semibold text-foreground">
            Pending suggestions
          </h2>
          <p class="mt-0.5 text-xs text-muted">
            Review detected preferences before they become persistent memory.
          </p>
        </div>
        {#if proposals.length > 0}
          <div class="space-y-2">
            {#each proposals as row (row.proposal.id)}
              <div class="rounded-lg border bg-elevated p-3">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <p class="text-sm font-medium text-foreground">{row.proposal.label}</p>
                    <p class="mt-1 text-xs leading-relaxed text-muted">{row.proposal.content}</p>
                    <p class="mt-1.5 text-[11px] capitalize text-dimmed">
                      {row.proposal.scope} · {row.proposal.category} · {row.proposal.priority}
                    </p>
                  </div>
                  <div class="flex shrink-0 items-center gap-1">
                    <button
                      class="rounded-md p-1.5 text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
                      type="button"
                      title="Approve this memory suggestion"
                      aria-label="Approve memory suggestion"
                      disabled={proposalBusyIds.includes(row.proposal.id)}
                      onclick={() => void resolveProposal(row, true)}
                    >
                      <Check size={15} />
                    </button>
                    <button
                      class="rounded-md p-1.5 text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
                      type="button"
                      title="Reject this memory suggestion"
                      aria-label="Reject memory suggestion"
                      disabled={proposalBusyIds.includes(row.proposal.id)}
                      onclick={() => void resolveProposal(row, false)}
                    >
                      <X size={15} />
                    </button>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {:else}
          <div class="rounded-lg border border-dashed p-6 text-center">
            <p class="text-sm text-dimmed">No pending proposals.</p>
            <p class="mt-1 text-xs text-dimmed">
              Newly detected preferences will appear here for review.
            </p>
          </div>
        {/if}
      </section>
    </div>
  {:else}
    <!-- Fixed filters and actions -->
    <div class="shrink-0">
      <div class="mb-3 flex items-center gap-3 text-xs text-dimmed">
        <span>{stats.total} entries</span>
        {#if variant === 'sidebar'}
          <span>{stats.enabled} enabled</span>
        {/if}
        {#if stats.autoDetected > 0}
          <span>{stats.autoDetected} auto-detected</span>
        {/if}
      </div>

      <div class="mb-3 flex flex-wrap items-center gap-2">
        <div class="relative min-w-[200px] flex-1">
          <Search size={14} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-dimmed" />
          <input
            class="w-full rounded-lg border bg-elevated pl-8 pr-3 py-1.5 text-sm text-foreground outline-none focus:border-primary"
            placeholder="Search memories..."
            bind:value={searchQuery}
          />
        </div>
        <select
          class="rounded-lg border bg-elevated px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary"
          bind:value={filterCategory}
        >
          <option value="">All categories</option>
          {#each Object.entries(categoryLabels) as [value, label] (value)}
            <option {value}>{label}</option>
          {/each}
        </select>
        <select
          class="rounded-lg border bg-elevated px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary"
          bind:value={filterPriority}
        >
          <option value="">All priorities</option>
          {#each Object.entries(priorityLabels) as [value, label] (value)}
            <option {value}>{label}</option>
          {/each}
        </select>
      </div>

      <div class="mb-4 flex items-center gap-3">
        <button
          class="flex items-center gap-1.5 rounded-lg border bg-elevated px-3 py-2 text-sm font-medium transition-colors hover:bg-overlay"
          title="Add a new memory entry"
          type="button"
          onclick={addEntry}
        >
          <Plus size={14} />
          Add Memory
        </button>
        <button
          class="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
          disabled={saving || loading}
          title="Save all memory entries"
          type="button"
          onclick={() => void save()}
        >
          {#if saving}
            <Loader2 size={14} class="animate-spin" />
          {:else}
            <Save size={14} />
          {/if}
          Save
        </button>
        {#if saved}
          <span class="text-xs text-primary">Saved</span>
        {/if}
      </div>
    </div>

    <!-- Entries list (scrollable) -->
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="space-y-3 pb-2">
        {#each filteredEntries as entry (`${entry.scope}:${entry.projectId ?? ''}:${entry.threadId ?? ''}:${entry.id}`)}
          <MemoryEntryComponent
            {entry}
            index={entries.indexOf(entry)}
            scopeOptions={availableScopes}
            onUpdate={updateEntry}
            onRemove={removeEntry}
          />
        {/each}
      </div>

      {#if filteredEntries.length === 0 && !loading}
        <div class="rounded-xl border border-dashed p-8 text-center">
          <p class="text-sm text-dimmed">{emptyState.title}</p>
          <p class="mt-1 text-xs text-dimmed">{emptyState.body}</p>
        </div>
      {/if}
    </div>
  {/if}
</div>
