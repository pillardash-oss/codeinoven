<script lang="ts">
  import { ChevronRight, Folder, Home, Loader2 } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import type { OvenFile } from '$shared/ovens'

  interface Props {
    /** Remote Oven whose filesystem is being browsed. */
    ovenId: string
    /** Directory the browser opens first (the Oven user's home). */
    root: string
    /** Currently opened directory. Kept in sync as the user navigates. */
    value: string
    disabled?: boolean
  }

  let { ovenId, root, value = $bindable(''), disabled = false }: Props = $props()

  let entries = $state<OvenFile[]>([])
  let loading = $state(false)
  let error = $state('')
  let typedPath = $state('')

  /** Which listing request is current, so a slow one cannot overwrite a newer. */
  let generation = 0

  /** The Oven's separator, taken from the starting directory it reported. */
  let separator = $derived(root.includes('\\') && !root.includes('/') ? '\\' : '/')

  /** Normalized current directory, with any trailing separator removed. */
  let current = $derived(trimTrailingSeparator(value))

  /**
   * Breadcrumb segments, each naming a directory from the filesystem root down
   * to the current one, so every ancestor is one click away.
   */
  let crumbs = $derived.by((): Array<{ label: string; path: string }> => {
    const path = current
    if (!path) return []
    const parts = path.split(/[\\/]+/u).filter(Boolean)
    const rooted = /^[\\/]/u.test(path)
    const result: Array<{ label: string; path: string }> = []
    let accumulated = rooted ? '' : ''
    for (let index = 0; index < parts.length; index += 1) {
      accumulated = accumulated ? joinPath(accumulated, parts[index], separator) : parts[index]
      result.push({
        label: parts[index],
        path: rooted ? `${separator}${accumulated}` : accumulated
      })
    }
    return result
  })

  let canGoUp = $derived(parentDirectory(current) !== null)

  /** Drop a trailing separator so `/home/user/` and `/home/user` compare equal. */
  function trimTrailingSeparator(path: string): string {
    return path.replace(/[\\/]+$/u, '') || path
  }

  /** Join a parent directory and a child name with the given separator. */
  function joinPath(parent: string, child: string, separator: string): string {
    if (!parent) return child
    return parent.endsWith(separator) ? `${parent}${child}` : `${parent}${separator}${child}`
  }

  /** The directory one level up, or null when already at a filesystem root. */
  function parentDirectory(path: string): string | null {
    const normalized = trimTrailingSeparator(path)
    // A Windows drive root (`C:\`) has no parent to climb to.
    if (/^[A-Za-z]:$/u.test(normalized)) return null
    const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
    if (lastSeparator <= 0) return null
    return normalized.slice(0, lastSeparator)
  }

  async function open(path: string): Promise<void> {
    if (disabled) return
    const target = path.trim()
    if (!target) return
    const token = ++generation
    loading = true
    error = ''
    // Point the selection at the directory being opened, even when listing it
    // fails, so the picker never keeps a folder the user has already left.
    value = target
    typedPath = target
    try {
      const result = await invoke('oven:workspace', ovenId, {
        operation: 'list',
        root: target,
        path: '.'
      })
      if (token !== generation) return
      entries = (result.files ?? [])
        .filter((entry) => entry.kind === 'directory')
        .sort((left, right) => left.path.localeCompare(right.path))
    } catch (failure) {
      if (token !== generation) return
      entries = []
      error = failure instanceof Error ? failure.message : 'This folder could not be read.'
    } finally {
      if (token === generation) loading = false
    }
  }

  // Load the starting directory on mount and whenever the Oven or its home
  // changes, so switching Ovens never leaves another Oven's listing on screen.
  $effect(() => {
    const id = ovenId
    const start = root
    if (!id || !start) return
    void open(start)
  })

  function submitTypedPath(event: SubmitEvent): void {
    event.preventDefault()
    void open(typedPath)
  }
</script>

<div class="space-y-2">
  <form class="flex items-center gap-2" onsubmit={submitTypedPath}>
    <button
      type="button"
      class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
      title="Go to the Oven home directory"
      aria-label="Go to the Oven home directory"
      disabled={disabled || !root}
      onclick={() => void open(root)}
    >
      <Home size={14} />
    </button>
    <button
      type="button"
      class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
      title="Go up one folder"
      aria-label="Go up one folder"
      disabled={disabled || !canGoUp}
      onclick={() => {
        const parent = parentDirectory(current)
        if (parent) void open(parent)
      }}
    >
      <ChevronRight size={14} class="rotate-[-90deg]" />
    </button>
    <input
      type="text"
      class="min-w-0 flex-1 rounded-lg border bg-elevated px-3 py-1.5 font-mono text-xs text-foreground placeholder:text-dimmed disabled:opacity-50"
      placeholder="/absolute/path/on/the/oven"
      title="Folder on the Oven"
      aria-label="Folder on the Oven"
      bind:value={typedPath}
      {disabled}
    />
    <button
      type="submit"
      class="shrink-0 rounded-lg border px-3 py-1.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
      title="Open this folder"
      {disabled}
    >
      Open
    </button>
  </form>

  {#if crumbs.length > 1}
    <nav class="flex flex-wrap items-center gap-0.5 text-xs" aria-label="Folder path">
      {#each crumbs as crumb, index (crumb.path)}
        {#if index > 0}
          <span class="text-dimmed" aria-hidden="true">/</span>
        {/if}
        <button
          type="button"
          class="max-w-32 truncate rounded px-1 py-0.5 transition-colors hover:bg-elevated hover:text-foreground {index ===
          crumbs.length - 1
            ? 'font-medium text-foreground'
            : 'text-muted'}"
          title={crumb.path}
          {disabled}
          onclick={() => void open(crumb.path)}
        >
          {crumb.label}
        </button>
      {/each}
    </nav>
  {/if}

  <div
    class="max-h-56 overflow-y-auto rounded-lg border bg-elevated/40"
    role="group"
    aria-label="Folders on the Oven"
  >
    {#if loading}
      <p class="flex items-center gap-2 px-3 py-3 text-xs text-muted">
        <Loader2 size={13} class="animate-spin" />
        Reading folders…
      </p>
    {:else if error}
      <p class="px-3 py-3 text-xs text-danger" role="alert">{error}</p>
    {:else if entries.length === 0}
      <p class="px-3 py-3 text-xs text-dimmed">No subfolders here.</p>
    {:else}
      {#each entries as entry (entry.path)}
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-elevated disabled:opacity-50"
          title={`Open ${entry.path}`}
          {disabled}
          onclick={() => void open(joinPath(current, entry.path, separator))}
        >
          <Folder size={14} class="shrink-0 text-muted" />
          <span class="min-w-0 flex-1 truncate">{entry.path}</span>
        </button>
      {/each}
    {/if}
  </div>
</div>
