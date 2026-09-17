<script lang="ts">
  import { DropdownMenu } from 'bits-ui'
  import {
    Check,
    FileText,
    MessageSquareText,
    Paperclip,
    Plus,
    Search,
    ShieldCheck,
    Upload,
    X
  } from '@lucide/svelte'
  import type {
    CapturableSpecContextType,
    SpecContextReference,
    SpecDecisionComment
  } from '$shared/types'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import type { SpecStudioContextPickerController } from './spec-studio-context-picker.svelte'
  import { formatDate } from './spec-studio-formatting'

  type CallbackResult = void | Promise<void>

  interface Props {
    context: SpecContextReference[]
    decisionComments: SpecDecisionComment[]
    busy: boolean
    picker: SpecStudioContextPickerController
    onAddContext: (type: CapturableSpecContextType, selectedPath?: string) => CallbackResult
    onRemoveContext: (contextId: string) => CallbackResult
  }

  let { context, decisionComments, busy, picker, onAddContext, onRemoveContext }: Props = $props()

  const contextTypes: Array<{
    type: CapturableSpecContextType
    label: string
    description: string
  }> = [
    {
      type: 'project_file',
      label: 'Tag project file',
      description: 'Tell the agent which project path to use'
    },
    {
      type: 'project_rule',
      label: 'Add rule or skill',
      description: 'Include project instructions in the run'
    },
    {
      type: 'attachment',
      label: 'Attach file',
      description: 'Copy an external file into this specification'
    }
  ]

  let contextDropActive = $state(false)

  const selectedContextPaths = $derived(
    new Set(
      context
        .map((reference) => reference.path)
        .filter((path): path is string => typeof path === 'string')
    )
  )

  function focusContextSearch(input: HTMLInputElement): void {
    input.focus()
  }

  async function selectContextPath(
    type: Exclude<CapturableSpecContextType, 'attachment'>,
    path: string
  ): Promise<void> {
    if (selectedContextPaths.has(path)) return
    await onAddContext(type, path)
  }

  function hasDroppedFiles(dataTransfer: DataTransfer | null): boolean {
    return Array.from(dataTransfer?.types ?? []).includes('Files')
  }

  function onContextDragOver(event: DragEvent): void {
    if (!hasDroppedFiles(event.dataTransfer)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    contextDropActive = true
  }

  function onContextDragLeave(event: DragEvent): void {
    if (
      event.clientX <= 0 ||
      event.clientY <= 0 ||
      event.clientX >= window.innerWidth ||
      event.clientY >= window.innerHeight
    ) {
      contextDropActive = false
    }
  }

  async function captureDroppedFiles(dataTransfer: DataTransfer | null): Promise<void> {
    const files = Array.from(dataTransfer?.files ?? [])
    for (const file of files) {
      try {
        const filePath = window.api.getPathForFile(file)
        if (filePath) await onAddContext('attachment', filePath)
      } catch {
        // Browser-only and remote drag sources do not expose a safe local path.
      }
    }
  }

  function onContextDrop(event: DragEvent): void {
    if (!hasDroppedFiles(event.dataTransfer)) return
    event.preventDefault()
    contextDropActive = false
    void captureDroppedFiles(event.dataTransfer)
  }
</script>

<svelte:document
  ondragover={onContextDragOver}
  ondragleave={onContextDragLeave}
  ondrop={onContextDrop}
/>

{#if contextDropActive}
  <div
    class="pointer-events-none fixed inset-0 z-100 flex items-center justify-center border-2 border-dashed border-primary bg-primary/20 backdrop-blur-sm"
    role="region"
    aria-label="Drop files into specification context"
  >
    <div class="flex flex-col items-center gap-2 text-primary">
      <Upload size={32} />
      <span class="text-base font-medium">Drop files into specification context</span>
    </div>
  </div>
{/if}

<section class="mt-12 border-t pt-6" aria-label="Specification context">
  <div class="flex items-center justify-between">
    <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">Context</h2>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        class="flex items-center gap-1 rounded-md border bg-elevated px-2 py-1 text-[0.6875rem] hover:bg-overlay"
        title="Add context to this specification"
      >
        <Plus size={11} />
        Add context
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          strategy="fixed"
          class="z-50 w-64 rounded-lg border border-border bg-surface p-1 shadow-lg"
        >
          {#each contextTypes as item (item.type)}
            <DropdownMenu.Item
              class="flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-left outline-none data-[highlighted]:bg-elevated"
              textValue={item.label}
              title={item.description}
              onSelect={() => {
                if (item.type === 'attachment') {
                  void onAddContext(item.type)
                } else {
                  void picker.open(item.type)
                }
              }}
            >
              {#if item.type === 'project_file'}
                <Search size={13} class="mt-0.5 shrink-0 text-muted" />
              {:else if item.type === 'project_rule'}
                <ShieldCheck size={13} class="mt-0.5 shrink-0 text-muted" />
              {:else}
                <Paperclip size={13} class="mt-0.5 shrink-0 text-muted" />
              {/if}
              <span class="min-w-0">
                <span class="block text-xs font-medium">{item.label}</span>
                <span class="mt-0.5 block text-[0.625rem] leading-tight text-dimmed">
                  {item.description}
                </span>
              </span>
            </DropdownMenu.Item>
          {/each}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  </div>
  {#if picker.pickerType}
    {@const activeContextPickerType = picker.pickerType}
    <div class="mt-3 rounded-lg border bg-surface p-3">
      <div class="flex items-center justify-between gap-3">
        <div>
          <h3 class="text-xs font-semibold">
            {picker.pickerType === 'project_rule' ? 'Add a rule or skill' : 'Tag a project file'}
          </h3>
          <p class="mt-0.5 text-[0.625rem] text-dimmed">
            The project-relative path will be included in review and implementation.
          </p>
        </div>
        <button
          type="button"
          class="rounded-md p-1 text-dimmed hover:bg-elevated hover:text-foreground"
          title="Close context search"
          aria-label="Close context search"
          onclick={() => picker.close()}
        >
          <X size={13} />
        </button>
      </div>
      <label class="relative mt-3 block">
        <span class="sr-only">Search project files</span>
        <Search
          size={13}
          class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dimmed"
        />
        <input
          {@attach focusContextSearch}
          value={picker.query}
          class="h-8 w-full rounded-md border bg-app pl-8 pr-3 text-xs outline-none"
          placeholder={picker.pickerType === 'project_rule'
            ? 'Search AGENTS.md, SKILL.md, rules…'
            : 'Search files by name or path…'}
          oninput={(event) => picker.handleQueryInput(event.currentTarget.value)}
        />
      </label>
      <div class="mt-2 max-h-52 overflow-y-auto">
        {#if picker.busy && picker.results.length === 0}
          <p class="px-2 py-3 text-center text-xs text-dimmed">Searching project…</p>
        {:else if picker.error}
          <p class="px-2 py-3 text-center text-xs text-danger">{picker.error}</p>
        {:else if picker.results.length === 0}
          <p class="px-2 py-3 text-center text-xs text-dimmed">
            {picker.pickerType === 'project_rule'
              ? 'No project rules or skills match this search.'
              : 'No project files match this search.'}
          </p>
        {:else}
          {#each picker.results as entry (entry.path)}
            {@const selected = selectedContextPaths.has(entry.path)}
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-elevated disabled:cursor-pointer disabled:opacity-60"
              title={selected ? `${entry.path} is already included` : `Include ${entry.path}`}
              disabled={selected || busy}
              onclick={() => void selectContextPath(activeContextPickerType, entry.path)}
            >
              <FileText size={12} class="shrink-0 text-muted" />
              <span class="min-w-0 flex-1 truncate">{entry.path}</span>
              {#if selected}
                <Check size={12} class="shrink-0 text-success" />
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    </div>
  {/if}
  <div class="mt-3 grid gap-2 sm:grid-cols-2">
    {#each context as reference (reference.id)}
      <div class="flex items-center gap-2 rounded-lg border bg-surface px-3 py-2">
        <span class="min-w-0 flex-1">
          <span class="block truncate text-xs font-medium">{reference.label}</span>
          <span class="block truncate text-[0.625rem] text-dimmed"
            >{reference.type.replace('_', ' ')}{reference.path ? ` · ${reference.path}` : ''}</span
          >
        </span>
        <button
          class="rounded-md p-1 text-dimmed hover:bg-danger/10 hover:text-danger"
          aria-label={`Remove context ${reference.label}`}
          title={`Remove ${reference.label}`}
          onclick={() => void onRemoveContext(reference.id)}
        >
          <X size={12} />
        </button>
      </div>
    {:else}
      <p class="col-span-full rounded-lg border border-dashed p-4 text-center text-xs text-dimmed">
        Tag project files, add rules or skills, attach external files, or drop files anywhere in the
        Studio.
      </p>
    {/each}
  </div>
  <div class="mt-6 border-t pt-4">
    <div class="flex items-center gap-1.5">
      <MessageSquareText size={13} class="text-muted" />
      <h3 class="text-xs font-semibold">Previous comments</h3>
    </div>
    {#if decisionComments.length > 0}
      <div class="mt-3 space-y-3">
        {#each decisionComments as comment (comment.id)}
          <div class="border-l-2 border-border pl-3">
            <div class="mb-1 flex items-center gap-2 text-[0.625rem] text-dimmed">
              <span class="font-semibold uppercase tracking-wide text-muted">
                {comment.action === 'review' ? 'Review' : 'Implement'}
              </span>
              <span>·</span>
              <span>{formatDate(comment.createdAt)}</span>
            </div>
            <div class="text-xs text-foreground">
              <MarkdownView text={comment.body} />
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <p class="mt-2 text-xs text-dimmed">
        No Review or Implement comments were submitted for this version.
      </p>
    {/if}
  </div>
</section>
