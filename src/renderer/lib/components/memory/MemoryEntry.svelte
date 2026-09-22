<script lang="ts">
  import type { MemoryCategory, MemoryEntry, MemoryPriority, Thread } from '$shared/types'
  import { DEFAULT_HARNESS } from '$shared/harness-default'
  import { locationScopeOf } from '$shared/memory/memory-scopes'
  import { parseModelKey } from '$lib/model-keys'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import type { ScopeProject } from '$lib/stores/scope.svelte'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import ProjectSelect from '../shared/ProjectSelect.svelte'
  import ThreadSelect from '../shared/ThreadSelect.svelte'
  import MemoryToggle from './MemoryToggle.svelte'
  import MemoryScopeSelect from './MemoryScopeSelect.svelte'
  import type { MemoryScopeOption } from './memory-routing'
  import { Trash2, ChevronDown, ChevronUp, Zap, Clock } from '@lucide/svelte'

  interface Props {
    entry: MemoryEntry
    index: number
    projectId?: string
    scopeOptions: readonly MemoryScopeOption[]
    /** Projects offered by the "Specific project" picker. */
    projects?: readonly ScopeProject[]
    /** Threads of the entry's project, offered by the "Thread" picker. */
    threads?: readonly Thread[]
    /** Whether the entry's project threads are still loading. */
    threadsLoading?: boolean
    initiallyExpanded?: boolean
    onUpdate: (
      index: number,
      field: keyof MemoryEntry,
      value: string | boolean | number | string[] | undefined
    ) => void
    onRemove: (index: number) => void
  }

  let {
    entry,
    index,
    projectId,
    scopeOptions,
    projects = [],
    threads = [],
    threadsLoading = false,
    initiallyExpanded,
    onUpdate,
    onRemove
  }: Props = $props()
  // newly-created memory should mount expanded; capturing the initial prop is intentional
  // svelte-ignore state_referenced_locally
  let expanded = $state(initiallyExpanded ?? false)
  let selectedModel = $derived(
    (entry.modelKeys ?? []).map((key) => parseModelKey(key)).find((model) => model !== null)
  )

  /** The option this entry's scope set lands on, which decides its pickers.
   *  A located entry names exactly one place; an audience-level entry matches
   *  whichever audience option its set contains. */
  let currentScopeOption = $derived.by(() => {
    const location = locationScopeOf(entry.scopes)
    if (location) return scopeOptions.find((option) => option.value === location)
    return scopeOptions.find((option) => entry.scopes.includes(option.value))
  })
  let showProjectPicker = $derived(currentScopeOption?.needsProject ?? false)
  let showThreadPicker = $derived(currentScopeOption?.needsThread ?? false)
  let selectedScopeProject = $derived(
    projects.find((project) => project.id === entry.projectId) ?? null
  )

  const categoryOptions: { value: MemoryCategory; label: string }[] = [
    { value: 'behavioral', label: 'Behavioral' },
    { value: 'project-rule', label: 'Project Rule' },
    { value: 'identity', label: 'Identity' },
    { value: 'preference', label: 'Preference' },
    { value: 'models', label: 'Models' }
  ]

  const priorityOptions: { value: MemoryPriority; label: string; color: string }[] = [
    { value: 'critical', label: 'Critical', color: 'text-danger' },
    { value: 'high', label: 'High', color: 'text-accent' },
    { value: 'medium', label: 'Medium', color: 'text-primary' },
    { value: 'low', label: 'Low', color: 'text-dimmed' }
  ]

  function getPriorityColor(priority: MemoryPriority): string {
    switch (priority) {
      case 'critical':
        return 'bg-danger/10 text-danger border-danger/20'
      case 'high':
        return 'bg-accent/10 text-accent border-accent/20'
      case 'medium':
        return 'bg-primary/10 text-primary border-primary/20'
      case 'low':
        return 'bg-elevated text-dimmed border-border'
    }
  }

  function getCategoryIcon(category: MemoryCategory): string {
    switch (category) {
      case 'behavioral':
        return 'B'
      case 'project-rule':
        return 'R'
      case 'identity':
        return 'I'
      case 'preference':
        return 'P'
      case 'models':
        return 'M'
    }
  }
</script>

<div
  class="rounded-xl border bg-surface transition-opacity {entry.enabled ? '' : 'opacity-50'}"
  role="group"
  aria-label="Memory entry: {entry.label || 'Untitled'}"
>
  <div class="flex items-center gap-3 p-4">
    <MemoryToggle
      enabled={entry.enabled}
      priority={entry.priority}
      onToggle={() => onUpdate(index, 'enabled', !entry.enabled)}
    />

    <button
      class="flex min-w-0 flex-1 items-center gap-2 text-left"
      type="button"
      aria-expanded={expanded}
      aria-controls="memory-details-{entry.id}"
      onclick={() => (expanded = !expanded)}
    >
      <span
        class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[0.625rem] font-bold {getPriorityColor(
          entry.priority
        )} border"
      >
        {getCategoryIcon(entry.category)}
      </span>
      <span class="truncate text-sm font-medium text-foreground">
        {entry.label || 'Untitled'}
      </span>
      {#if entry.source === 'auto-detected'}
        <span
          class="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-accent"
        >
          Auto
        </span>
      {/if}
      {#if entry.frequency > 1}
        <span class="shrink-0 flex items-center gap-0.5 text-[0.625rem] text-dimmed">
          <Zap size={10} />
          {entry.frequency}x
        </span>
      {/if}
    </button>

    <div class="flex items-center gap-1">
      <button
        class="rounded-md p-1.5 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title={expanded ? 'Collapse' : 'Expand'}
        aria-label={expanded ? 'Collapse entry' : 'Expand entry'}
        onclick={() => (expanded = !expanded)}
      >
        {#if expanded}
          <ChevronUp size={14} />
        {:else}
          <ChevronDown size={14} />
        {/if}
      </button>
      <button
        class="rounded-md p-1.5 text-dimmed transition-colors hover:bg-danger/10 hover:text-danger"
        title="Delete this memory entry"
        aria-label="Delete memory entry"
        onclick={() => onRemove(index)}
      >
        <Trash2 size={14} />
      </button>
    </div>
  </div>

  {#if expanded}
    <div id="memory-details-{entry.id}" class="border-t px-4 pb-4 pt-3 space-y-3">
      <div>
        <label class="mb-1.5 block text-xs font-medium text-muted" for="memory-label-{entry.id}">
          Label
        </label>
        <input
          id="memory-label-{entry.id}"
          class="w-full rounded-lg border bg-elevated px-3 py-1.5 text-sm text-foreground outline-none focus:border-primary"
          value={entry.label}
          placeholder="e.g. Preferred language"
          oninput={(e: Event) => {
            const target = e.currentTarget as HTMLInputElement
            onUpdate(index, 'label', target.value)
          }}
        />
      </div>

      <div>
        <label class="mb-1.5 block text-xs font-medium text-muted" for="memory-content-{entry.id}">
          Content
        </label>
        <RichMarkdownEditor
          id="memory-content-{entry.id}"
          value={entry.content}
          placeholder="Write the memory content in Markdown..."
          containerClass="border border-border rounded-lg"
          class="min-h-24 max-h-48 w-full overflow-y-auto px-3.5 pt-3 pb-1 text-sm leading-5 text-foreground outline-none"
          onValueChange={(value) => onUpdate(index, 'content', value)}
        />
      </div>

      <div class="grid grid-cols-3 gap-3">
        <div>
          <label class="mb-1 block text-xs font-medium text-muted" for="memory-category-{entry.id}">
            Category
          </label>
          <select
            id="memory-category-{entry.id}"
            class="w-full rounded-lg border bg-elevated px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary"
            value={entry.category}
            onchange={(e: Event) => {
              const target = e.currentTarget as HTMLSelectElement
              onUpdate(index, 'category', target.value)
            }}
          >
            {#each categoryOptions as opt (opt.value)}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        </div>

        <div>
          <label class="mb-1 block text-xs font-medium text-muted" for="memory-priority-{entry.id}">
            Priority
          </label>
          <select
            id="memory-priority-{entry.id}"
            class="w-full rounded-lg border bg-elevated px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary"
            value={entry.priority}
            onchange={(e: Event) => {
              const target = e.currentTarget as HTMLSelectElement
              onUpdate(index, 'priority', target.value)
            }}
          >
            {#each priorityOptions as opt (opt.value)}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        </div>

        <div>
          <span class="mb-1 block text-xs font-medium text-muted">Scope</span>
          <MemoryScopeSelect
            scopes={entry.scopes}
            options={scopeOptions}
            onScopesChange={(nextScopes) => onUpdate(index, 'scopes', nextScopes)}
            ariaLabel="Select which audiences or places this memory applies to"
            title="Select which audiences or places this memory applies to"
          />
        </div>
      </div>

      {#if showProjectPicker || showThreadPicker}
        <div
          class="grid gap-3 {showProjectPicker && showThreadPicker ? 'grid-cols-2' : 'grid-cols-1'}"
        >
          {#if showProjectPicker}
            <div>
              <span class="mb-1 block text-xs font-medium text-muted">Project</span>
              <ProjectSelect
                {projects}
                value={entry.projectId ?? null}
                onValueChange={(nextProjectId) => onUpdate(index, 'projectId', nextProjectId)}
                ariaLabel="Select the project this memory applies to"
                placeholder="Select a project"
                searchPlaceholder="Search projects…"
                emptyMessage="No projects match this search"
              />
            </div>
          {/if}
          {#if showThreadPicker}
            <div>
              <span class="mb-1 block text-xs font-medium text-muted">Thread</span>
              <ThreadSelect
                {threads}
                project={selectedScopeProject}
                value={entry.threadId ?? null}
                onValueChange={(nextThreadId) => onUpdate(index, 'threadId', nextThreadId)}
                ariaLabel="Select the thread this memory applies to"
                placeholder="Select a thread"
                searchPlaceholder="Search this project's threads…"
                emptyMessage={threadsLoading
                  ? 'Loading threads…'
                  : entry.projectId
                    ? 'No threads match this search'
                    : 'Select a project first'}
                disabled={!entry.projectId && !projectId}
              />
            </div>
          {/if}
        </div>
        {#if showProjectPicker && !entry.projectId}
          <p class="text-[0.6875rem] text-danger" role="alert">
            Choose a project before saving this entry.
          </p>
        {/if}
        {#if showThreadPicker && !entry.threadId}
          <p class="text-[0.6875rem] text-danger" role="alert">
            Choose a thread before saving this entry.
          </p>
        {/if}
      {/if}

      {#if entry.category === 'models'}
        <div class="rounded-lg border border-primary/20 bg-primary/5 p-3">
          <div class="mb-2">
            <p class="text-xs font-medium text-foreground">Models this memory applies to</p>
            <p class="mt-0.5 text-[0.6875rem] text-muted">
              Select one or more models. This memory is injected only when one of them is active.
            </p>
          </div>
          <ModelPicker
            providers={providerCatalog.allCached()}
            {projectId}
            harnessId={selectedModel?.harnessId ?? DEFAULT_HARNESS}
            providerId={selectedModel?.providerId ?? ''}
            modelId={selectedModel?.modelId ?? ''}
            variant="field"
            multiSelect
            selectedModelKeys={entry.modelKeys ?? []}
            onSelect={() => undefined}
            onSelectMultiple={(modelKeys) => onUpdate(index, 'modelKeys', modelKeys)}
          />
          {#if (entry.modelKeys?.length ?? 0) === 0}
            <p class="mt-2 text-[0.6875rem] text-danger" role="alert">
              Choose at least one model before saving this entry.
            </p>
          {/if}
        </div>
      {/if}

      <div class="flex items-center gap-4 text-[0.6875rem] text-dimmed">
        <span class="flex items-center gap-1">
          <Clock size={10} />
          Updated {new Date(entry.updatedAt).toLocaleDateString()}
        </span>
        {#if entry.lastReinforced}
          <span class="flex items-center gap-1">
            <Zap size={10} />
            Reinforced {entry.frequency}x
          </span>
        {/if}
        <span>Source: {entry.source}</span>
      </div>
    </div>
  {/if}
</div>
