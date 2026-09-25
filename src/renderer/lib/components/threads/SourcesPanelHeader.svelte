<script lang="ts">
  import {
    Brain,
    Image as ImageIcon,
    Loader2,
    RefreshCw,
    Search,
    SquareTerminal
  } from '@lucide/svelte'
  import type {
    ContextSection,
    OriginFilter,
    SourceFilter,
    SourcesSection
  } from './sources-panel-helpers'

  interface Props {
    section: SourcesSection
    contextSection: ContextSection
    originFilter: OriginFilter
    sourceFilter: SourceFilter
    searchQuery: string
    /** Every collected source, before the active kind filter. */
    sourceCount: number
    /** Sources matching the active kind filter. */
    visibleSourceCount: number
    attachmentCount: number
    webCount: number
    imageCount: number
    citationCount: number
    sectionCount: number
    artifactCount: number
    memoryCount: number
    processCount: number
    mcpCount: number
    skillCount: number
    harnessName: string | null | undefined
    processesRefreshing: boolean
    processesLoading: boolean
    stoppingAll: boolean
    onToggleSourceFilter: (kind: SourceFilter) => void
    onRefreshProcesses: () => void
    onStopAllProcesses: () => void
    /** Called when the reader opens the memory sub-tab, which reloads it. */
    onMemoryRequested: () => void
  }

  let {
    section = $bindable(),
    contextSection = $bindable(),
    originFilter = $bindable(),
    sourceFilter = $bindable(),
    searchQuery = $bindable(),
    sourceCount,
    visibleSourceCount,
    attachmentCount,
    webCount,
    imageCount,
    citationCount,
    sectionCount,
    artifactCount,
    memoryCount,
    processCount,
    mcpCount,
    skillCount,
    harnessName,
    processesRefreshing,
    processesLoading,
    stoppingAll,
    onToggleSourceFilter,
    onRefreshProcesses,
    onStopAllProcesses,
    onMemoryRequested
  }: Props = $props()
</script>

<header class="shrink-0 border-b border-border px-4 py-3">
  <div class="flex items-baseline justify-between gap-3">
    <div>
      <h2 class="text-sm font-semibold text-foreground">Sources</h2>
      <p class="mt-0.5 text-[0.6875rem] text-dimmed">
        {#if section === 'sources'}
          Attachments, researched websites, and generated images.
        {:else if section === 'artifacts'}
          Generated images captured from this conversation.
        {:else if section === 'processes'}
          Commands still running for this task.
        {:else if contextSection === 'mcps'}
          MCP servers available to this conversation.
        {:else if contextSection === 'skills'}
          Reusable skills available to this conversation.
        {:else}
          Active memory applied to this conversation.
        {/if}
      </p>
    </div>
    <span class="text-xs font-semibold tabular-nums text-muted">
      {#if section === 'sources'}
        {visibleSourceCount}{#if sourceFilter !== 'all' && visibleSourceCount !== sourceCount}
          <span class="text-dimmed"> / {sourceCount}</span>
        {/if}
      {:else if section === 'artifacts'}
        {artifactCount}
      {:else if section === 'processes'}
        {processCount}
      {:else if contextSection === 'mcps'}
        {mcpCount}
      {:else if contextSection === 'skills'}
        {skillCount}
      {:else}
        {memoryCount}
      {/if}
    </span>
  </div>

  <div
    class="mt-3 flex w-full items-center gap-0.5 overflow-x-auto rounded-lg border bg-elevated p-0.5"
    role="tablist"
    aria-label="Sources sections"
  >
    <button
      type="button"
      class="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors {section ===
      'sources'
        ? 'bg-surface text-foreground shadow-sm'
        : 'text-muted hover:text-foreground'}"
      role="tab"
      aria-selected={section === 'sources'}
      title="View conversation sources"
      onclick={() => (section = 'sources')}
    >
      Sources
    </button>
    <button
      type="button"
      class="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors {section ===
      'processes'
        ? 'bg-surface text-foreground shadow-sm'
        : 'text-muted hover:text-foreground'}"
      role="tab"
      aria-selected={section === 'processes'}
      title="View commands still running for this task"
      onclick={() => (section = 'processes')}
    >
      Processes
      {#if processCount > 0}<span class="text-[0.625rem] tabular-nums">{processCount}</span>{/if}
    </button>
    <button
      type="button"
      class="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors {section ===
      'artifacts'
        ? 'bg-surface text-foreground shadow-sm'
        : 'text-muted hover:text-foreground'}"
      role="tab"
      aria-selected={section === 'artifacts'}
      title="View generated image artifacts"
      onclick={() => (section = 'artifacts')}
    >
      <ImageIcon size={12} />
      Artifacts
      {#if artifactCount > 0}<span class="text-[0.625rem] tabular-nums">{artifactCount}</span>{/if}
    </button>
    <button
      type="button"
      class="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors {section ===
      'contexts'
        ? 'bg-surface text-foreground shadow-sm'
        : 'text-muted hover:text-foreground'}"
      role="tab"
      aria-selected={section === 'contexts'}
      title="View MCP servers, skills, and memory for this conversation"
      onclick={() => {
        section = 'contexts'
        if (contextSection === 'memory') onMemoryRequested()
      }}
    >
      <Brain size={12} />
      Contexts
      {#if contextSection === 'memory' && memoryCount > 0}
        <span class="text-[0.625rem] tabular-nums">{memoryCount}</span>
      {/if}
    </button>
  </div>

  {#if section === 'contexts'}
    <div
      class="mt-3 flex w-full items-center gap-0.5 overflow-x-auto rounded-lg border bg-elevated p-0.5"
      role="tablist"
      aria-label="Context sections"
    >
      <button
        type="button"
        class="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[0.6875rem] font-medium transition-colors {contextSection ===
        'mcps'
          ? 'bg-surface text-foreground shadow-sm'
          : 'text-muted hover:text-foreground'}"
        role="tab"
        aria-selected={contextSection === 'mcps'}
        title="View MCP servers available to this conversation"
        onclick={() => (contextSection = 'mcps')}
      >
        MCPs
      </button>
      <button
        type="button"
        class="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[0.6875rem] font-medium transition-colors {contextSection ===
        'skills'
          ? 'bg-surface text-foreground shadow-sm'
          : 'text-muted hover:text-foreground'}"
        role="tab"
        aria-selected={contextSection === 'skills'}
        title="View skills available to this conversation"
        onclick={() => (contextSection = 'skills')}
      >
        Skills
      </button>
      <button
        type="button"
        class="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[0.6875rem] font-medium transition-colors {contextSection ===
        'memory'
          ? 'bg-surface text-foreground shadow-sm'
          : 'text-muted hover:text-foreground'}"
        role="tab"
        aria-selected={contextSection === 'memory'}
        title="View active memory applied to this conversation"
        onclick={() => {
          contextSection = 'memory'
          onMemoryRequested()
        }}
      >
        Memory
        {#if memoryCount > 0}<span class="text-[0.625rem] tabular-nums">{memoryCount}</span>{/if}
      </button>
    </div>
  {/if}

  {#if (section === 'contexts' && contextSection === 'mcps') || (section === 'contexts' && contextSection === 'skills')}
    <div
      class="mt-3 flex w-max items-center gap-0.5 rounded-lg border bg-elevated p-0.5"
      role="group"
      aria-label="Filter by origin"
    >
      <button
        type="button"
        class="rounded-md px-2.5 py-1 text-[0.6875rem] font-medium transition-colors {originFilter ===
        'all'
          ? 'bg-surface text-foreground shadow-sm'
          : 'text-muted hover:text-foreground'}"
        aria-pressed={originFilter === 'all'}
        title="Show capabilities from every source"
        onclick={() => (originFilter = 'all')}
      >
        All
      </button>
      <button
        type="button"
        class="rounded-md px-2.5 py-1 text-[0.6875rem] font-medium transition-colors {originFilter ===
        'application'
          ? 'bg-surface text-foreground shadow-sm'
          : 'text-muted hover:text-foreground'}"
        aria-pressed={originFilter === 'application'}
        title="Show CodeInOven-managed capabilities"
        onclick={() => (originFilter = 'application')}
      >
        CodeInOven
      </button>
      <button
        type="button"
        class="rounded-md px-2.5 py-1 text-[0.6875rem] font-medium transition-colors {originFilter ===
        'global'
          ? 'bg-surface text-foreground shadow-sm'
          : 'text-muted hover:text-foreground'}"
        aria-pressed={originFilter === 'global'}
        title="Show global capabilities available to every harness"
        onclick={() => (originFilter = 'global')}
      >
        Global
      </button>
      <button
        type="button"
        class="rounded-md px-2.5 py-1 text-[0.6875rem] font-medium transition-colors {originFilter ===
        'harness'
          ? 'bg-surface text-foreground shadow-sm'
          : 'text-muted hover:text-foreground'}"
        aria-pressed={originFilter === 'harness'}
        title={`Show capabilities from ${harnessName ?? 'this harness'}`}
        onclick={() => (originFilter = 'harness')}
      >
        {harnessName ?? 'Harness'}
      </button>
    </div>
    <label class="relative mt-3 block">
      <Search
        size={13}
        class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dimmed"
      />
      <span class="sr-only">Search {contextSection === 'mcps' ? 'MCP servers' : 'skills'}</span>
      <input
        class="h-8 w-full rounded-lg border bg-elevated pl-8 pr-3 text-xs outline-none placeholder:text-dimmed focus:border-primary"
        type="search"
        placeholder={contextSection === 'mcps' ? 'Search MCP servers' : 'Search skills'}
        bind:value={searchQuery}
      />
    </label>
  {/if}

  {#if section === 'sources' && sourceCount > 0}
    <div class="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter sources by kind">
      <button
        type="button"
        class="rounded-md px-1.5 py-0.5 text-[0.625rem] font-medium tabular-nums transition-colors {sourceFilter ===
        'all'
          ? 'bg-primary/15 text-primary'
          : 'bg-raised text-muted hover:text-foreground'}"
        aria-pressed={sourceFilter === 'all'}
        title="Show every kind of source"
        onclick={() => onToggleSourceFilter('all')}
      >
        {sourceCount} all
      </button>
      <button
        type="button"
        class="rounded-md px-1.5 py-0.5 text-[0.625rem] font-medium tabular-nums transition-colors {sourceFilter ===
        'attachment'
          ? 'bg-primary/15 text-primary'
          : 'bg-raised text-muted hover:text-foreground'}"
        aria-pressed={sourceFilter === 'attachment'}
        title="Show only attached files"
        onclick={() => onToggleSourceFilter('attachment')}
      >
        {attachmentCount} attachments
      </button>
      <button
        type="button"
        class="rounded-md px-1.5 py-0.5 text-[0.625rem] font-medium tabular-nums transition-colors {sourceFilter ===
        'web'
          ? 'bg-primary/15 text-primary'
          : 'bg-raised text-muted hover:text-foreground'}"
        aria-pressed={sourceFilter === 'web'}
        title="Show only websites cited or fetched by the agent"
        onclick={() => onToggleSourceFilter('web')}
      >
        {webCount} web
      </button>
      <button
        type="button"
        class="rounded-md px-1.5 py-0.5 text-[0.625rem] font-medium tabular-nums transition-colors {sourceFilter ===
        'generated-image'
          ? 'bg-primary/15 text-primary'
          : 'bg-raised text-muted hover:text-foreground'}"
        aria-pressed={sourceFilter === 'generated-image'}
        title="Show only generated images"
        onclick={() => onToggleSourceFilter('generated-image')}
      >
        {imageCount} images
      </button>
      {#if citationCount > 0}
        <button
          type="button"
          class="rounded-md px-1.5 py-0.5 text-[0.625rem] font-medium tabular-nums transition-colors {sourceFilter ===
          'file-citation'
            ? 'bg-primary/15 text-primary'
            : 'bg-raised text-muted hover:text-foreground'}"
          aria-pressed={sourceFilter === 'file-citation'}
          title="Show only files cited by the agent"
          onclick={() => onToggleSourceFilter('file-citation')}
        >
          {citationCount} cited files
        </button>
      {/if}
      {#if sectionCount > 0}
        <button
          type="button"
          class="rounded-md px-1.5 py-0.5 text-[0.625rem] font-medium tabular-nums transition-colors {sourceFilter ===
          'section'
            ? 'bg-primary/15 text-primary'
            : 'bg-raised text-muted hover:text-foreground'}"
          aria-pressed={sourceFilter === 'section'}
          title="Show only conversation sections referenced by the agent"
          onclick={() => onToggleSourceFilter('section')}
        >
          {sectionCount} sections
        </button>
      {/if}
    </div>
  {/if}

  {#if section === 'processes'}
    <div class="mt-3 flex items-center gap-2">
      <button
        type="button"
        class="inline-flex h-8 w-28 items-center justify-center gap-1.5 rounded-lg border border-border bg-elevated px-2.5 text-xs font-medium text-muted transition-colors hover:bg-overlay hover:text-foreground disabled:opacity-50"
        disabled={processesRefreshing || processesLoading}
        title="Refresh running processes"
        onclick={onRefreshProcesses}
      >
        {#if processesRefreshing}
          <Loader2 size={13} class="animate-spin" />
        {:else}
          <RefreshCw size={13} />
        {/if}
        <span aria-live="polite">{processesRefreshing ? 'Refreshing…' : 'Refresh'}</span>
      </button>
      {#if processCount > 0}
        <button
          type="button"
          class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-danger/30 bg-danger/10 px-2.5 text-xs font-medium text-danger transition-colors hover:bg-danger/15 disabled:opacity-50"
          disabled={stoppingAll}
          title="Stop all processes running for this task"
          onclick={onStopAllProcesses}
        >
          {#if stoppingAll}
            <Loader2 size={13} class="animate-spin" />
          {:else}
            <SquareTerminal size={13} />
          {/if}
          Stop all
        </button>
      {/if}
    </div>
  {/if}
</header>
