<script lang="ts">
  import { ChevronRight, ListTodo, Wrench } from '@lucide/svelte'
  import type { AssignmentTask, ProjectFileEntry } from '$shared/types'
  import { composerMentionKey, type ComposerMentionEntry } from './composer-mentions'
  import { cioSearchVisibility } from '$lib/stores/cio-search-visibility.svelte'
  import Switch from '../ui/Switch.svelte'
  import FileTypeIcon from '../files/FileTypeIcon.svelte'
  import FolderTypeIcon from '../files/FolderTypeIcon.svelte'

  interface Props {
    entries: ComposerMentionEntry[]
    activeIndex: number
    query: string
    onSelect: (entry: ComposerMentionEntry) => void
    /** Re-run the mention search after the .cio visibility switch toggles, so
     *  the open result list reflects the new state immediately. */
    onCioFilterChange: () => void
  }

  let { entries, activeIndex, query, onSelect, onCioFilterChange }: Props = $props()
  let listboxElement: HTMLDivElement

  $effect(() => {
    const selectedIndex = activeIndex
    const entryCount = entries.length
    const frame = requestAnimationFrame(() => {
      if (selectedIndex < 0 || selectedIndex >= entryCount) return
      listboxElement
        ?.querySelector<HTMLElement>('[aria-selected="true"]')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  })

  function parentPath(entry: ProjectFileEntry): string {
    const separator = entry.path.lastIndexOf('/')
    return separator >= 0 ? entry.path.slice(0, separator) : 'Project root'
  }

  function taskWorker(task: AssignmentTask): string {
    return task.workerName ?? (task.owner === 'senior' ? 'Sr. Engineer' : 'Unassigned')
  }
</script>

<div
  bind:this={listboxElement}
  class="absolute bottom-full left-3 right-3 z-40 mb-1 max-h-56 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg"
  role="listbox"
  aria-label="Composer references"
>
  <div class="flex items-center justify-between gap-2 px-2 py-1">
    <p class="min-w-0 truncate text-[10px] font-semibold uppercase tracking-wide text-dimmed">
      {query ? `References matching “${query}”` : 'Built-in actions, files, and Assignment tasks'}
    </p>
    <Switch
      checked={cioSearchVisibility.includeCio}
      label="cio files"
      class="text-[10px] font-semibold text-dimmed"
      title="Include .cio files in tag search"
      aria-label="Include .cio files in tag search"
      onmousedown={(event: MouseEvent) => event.preventDefault()}
      onchange={(checked: boolean) => {
        cioSearchVisibility.setIncludeCio(checked)
        onCioFilterChange()
      }}
    />
  </div>
  {#if entries.length === 0}
    <p class="px-2 py-2 text-xs text-dimmed">No matching references</p>
  {:else}
    {#each entries as mention, index (composerMentionKey(mention))}
      <button
        type="button"
        class={[
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none',
          index === activeIndex ? 'bg-elevated text-foreground' : 'text-muted hover:bg-elevated'
        ]}
        role="option"
        aria-selected={index === activeIndex}
        title={mention.type === 'utility'
          ? mention.entry.description
          : mention.type === 'task'
            ? `Task: ${mention.entry.title} · Worker: ${taskWorker(mention.entry)}`
            : mention.entry.path}
        onmousedown={(event: MouseEvent) => event.preventDefault()}
        onclick={() => onSelect(mention)}
      >
        {#if mention.type === 'utility'}
          <Wrench size={13} class="shrink-0 text-primary" />
        {:else if mention.type === 'task'}
          <ListTodo size={13} class="shrink-0 text-info" />
        {:else if mention.entry.kind === 'directory'}
          <FolderTypeIcon name={mention.entry.name} size={13} />
        {:else}
          <FileTypeIcon path={mention.entry.path} />
        {/if}
        <span class="min-w-0 flex-1">
          {#if mention.type === 'utility'}
            <span class="block truncate">{mention.entry.name}</span>
            <span class="block truncate text-[10px] text-dimmed"> Built-in utility setup </span>
          {:else if mention.type === 'task'}
            <span class="block truncate">{mention.entry.title}</span>
            <span class="block truncate text-[10px] capitalize text-dimmed">
              Task · {mention.entry.status} · {taskWorker(mention.entry)}
            </span>
          {:else}
            <span class="block truncate">{mention.entry.name}</span>
            <span class="block truncate text-[10px] text-dimmed">
              {parentPath(mention.entry)}
            </span>
          {/if}
        </span>
        {#if mention.type === 'project' && mention.entry.kind === 'directory'}
          <ChevronRight size={12} class="shrink-0 text-dimmed" />
        {/if}
      </button>
    {/each}
  {/if}
</div>
