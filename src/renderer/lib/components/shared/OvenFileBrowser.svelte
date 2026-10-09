<script lang="ts">
  import { ChevronRight, Folder, FolderPlus, Home, Loader2 } from '@lucide/svelte'
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

  /** Inline "new folder" row: whether it is open, busy, and what it will create. */
  let creating = $state(false)
  let creatingBusy = $state(false)
  let newFolderName = $state('')
  let createError = $state('')

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
    // A rooted path climbs all the way to `/`, so the root is its own first crumb
    // and every ancestor below it is one click away.
    const result: Array<{ label: string; path: string }> = rooted
      ? [{ label: separator, path: separator }]
      : []
    let accumulated = ''
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

  /**
   * The directory one level up, or null when already at a filesystem root.
   *
   * `/home` climbs to `/`   the root is a real listing, not a dead end   and a
   * Windows drive root (`C:\`) is the only place with nowhere above it.
   */
  function parentDirectory(path: string): string | null {
    const normalized = trimTrailingSeparator(path)
    if (normalized === '' || normalized === separator) return null
    if (/^[A-Za-z]:[\\/]?$/u.test(normalized)) return null
    const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
    if (lastSeparator < 0) return null
    if (lastSeparator === 0) return separator
    const parent = normalized.slice(0, lastSeparator)
    return /^[A-Za-z]:$/u.test(parent) ? `${parent}${separator}` : parent
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

  function startCreate(): void {
    if (disabled || !current) return
    newFolderName = ''
    createError = ''
    creating = true
  }

  function cancelCreate(): void {
    creating = false
    creatingBusy = false
    newFolderName = ''
    createError = ''
  }

  /** Create a folder in the open directory, then step into it. */
  async function submitNewFolder(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const name = newFolderName.trim()
    if (!name || disabled || creatingBusy || !current) return
    if (name === '.' || name === '..' || /[\\/]/u.test(name)) {
      createError = 'Enter a single folder name with no slashes.'
      return
    }
    creatingBusy = true
    createError = ''
    const target = joinPath(current, name, separator)
    try {
      await invoke('oven:workspace', ovenId, {
        operation: 'mkdir',
        root: current,
        path: name,
        exclusive: true
      })
      creating = false
      newFolderName = ''
      await open(target)
    } catch (failure) {
      const message =
        failure instanceof Error ? failure.message : 'The folder could not be created.'
      createError = /EEXIST/u.test(message)
        ? 'A folder with that name already exists here.'
        : message
    } finally {
      creatingBusy = false
    }
  }

  // Focus the name field the moment the create row appears.
  function focusOnMount(node: HTMLInputElement): void {
    node.focus()
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

  <div class="flex items-center gap-2">
    {#if crumbs.length > 0}
      <nav
        class="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 text-xs"
        aria-label="Folder path"
      >
        {#each crumbs as crumb, index (crumb.path)}
          {#if index > 0 && !(index === 1 && crumbs[0]?.path === separator)}
            <span class="text-dimmed" aria-hidden="true">{separator}</span>
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
    {:else}
      <span class="min-w-0 flex-1"></span>
    {/if}
    <button
      type="button"
      class="flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
      title="Create a folder in this directory"
      aria-label="Create a folder in this directory"
      disabled={disabled || loading || !current}
      onclick={startCreate}
    >
      <FolderPlus size={13} />
      New folder
    </button>
  </div>

  {#if creating}
    <form class="flex items-center gap-2" onsubmit={submitNewFolder}>
      <input
        type="text"
        class="min-w-0 flex-1 rounded-lg border bg-elevated px-3 py-1.5 text-xs text-foreground placeholder:text-dimmed disabled:opacity-50"
        placeholder="Folder name"
        title={`Create a folder in ${current}`}
        aria-label="New folder name"
        {@attach focusOnMount}
        bind:value={newFolderName}
        disabled={disabled || creatingBusy}
      />
      <button
        type="submit"
        class="shrink-0 rounded-lg border px-3 py-1.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
        title="Create this folder"
        disabled={disabled || creatingBusy || !newFolderName.trim()}
      >
        Create
      </button>
      <button
        type="button"
        class="shrink-0 rounded-lg px-2 py-1.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
        title="Cancel"
        disabled={creatingBusy}
        onclick={cancelCreate}
      >
        Cancel
      </button>
    </form>
    {#if createError}
      <p class="text-xs text-danger" role="alert">{createError}</p>
    {/if}
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
