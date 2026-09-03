<script lang="ts">
  import { FolderInput, Loader2, GitBranch } from '@lucide/svelte'
  import Modal from '../ui/Modal.svelte'
  import DockableModal from '../ui/DockableModal.svelte'
  import ProviderLoginTerminal from '../providers/ProviderLoginTerminal.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { APP_NAME } from '$shared/brand'
  import type { Project } from '$shared/types'

  interface Props {
    open: boolean
    onClose: () => void
    onProjectCreated: (project: Project) => void | Promise<void>
  }

  let { open, onClose, onProjectCreated }: Props = $props()

  let gitUrl = $state('')
  let destination = $state('')
  let repoName = $state('')
  let busy = $state(false)
  let error = $state('')
  let showTerminal = $state(false)
  let terminalId = $state('')
  let handoff = $state<{ command: string; args: string[]; destination: string; repoName: string } | null>(null)
  let exitCode = $state<number | undefined>(undefined)
  let minimized = $state(false)

  // Derive default destination when url changes and user hasn't manually edited destination
  let userEditedDestination = $state(false)

  async function deriveDefaultPath(url: string): Promise<string> {
    if (!url.trim()) return ''
    try {
      const p = (await invoke('git:defaultClonePath', url.trim())) as string
      return typeof p === 'string' ? p : ''
    } catch {
      return ''
    }
  }

  $effect(() => {
    const url = gitUrl
    if (!userEditedDestination && url.trim()) {
      void deriveDefaultPath(url).then((p) => {
        if (p && !userEditedDestination) {
          destination = p
          const seg = p.split('/').filter(Boolean).pop() ?? ''
          repoName = seg
        }
      })
    }
    if (!url.trim() && !userEditedDestination) {
      destination = ''
      repoName = ''
    }
  })

  function resetState(): void {
    gitUrl = ''
    destination = ''
    repoName = ''
    busy = false
    error = ''
    showTerminal = false
    terminalId = ''
    handoff = null
    exitCode = undefined
    minimized = false
    userEditedDestination = false
  }

  function handleClose(): void {
    if (busy && !showTerminal) return
    if (showTerminal && exitCode === undefined) {
      // Let the clone keep running in background minimized — minimize instead of closing
      minimized = true
      return
    }
    resetState()
    onClose()
  }

  async function pickDestination(): Promise<void> {
    const chosen = (await invoke('dialog:pickCloneDestination')) as string | null
    if (!chosen) return
    // If user picks a directory, we treat it as parent; append repoName if present
    const baseName = repoName || deriveRepoNameLocal(gitUrl) || 'repo'
    const alreadyEndsWithRepo = chosen.endsWith(`/${baseName}`) || chosen.endsWith(baseName)
    if (alreadyEndsWithRepo) {
      destination = chosen
    } else {
      // If chosen is a directory that exists, append repo name
      destination = `${chosen.replace(/\/+$/u, '')}/${baseName}`
    }
    userEditedDestination = true
  }

  function deriveRepoNameLocal(url: string): string {
    const trimmed = url.trim().replace(/\/+$/u, '')
    if (!trimmed) return ''
    const withoutQuery = trimmed.split('?')[0].split('#')[0]
    const lastSlash = withoutQuery.lastIndexOf('/')
    const lastColon = withoutQuery.lastIndexOf(':')
    const sepIndex = Math.max(lastSlash, lastColon)
    const segment = sepIndex >= 0 ? withoutQuery.slice(sepIndex + 1) : withoutQuery
    const withoutGit = segment.endsWith('.git') ? segment.slice(0, -4) : segment
    const sanitized = withoutGit.replace(/[^A-Za-z0-9._-]/gu, '-').replace(/^-+/u, '').replace(/-+$/u, '')
    return sanitized || ''
  }

  async function startClone(): Promise<void> {
    if (!gitUrl.trim()) {
      error = 'Git URL is required.'
      return
    }
    if (!destination.trim()) {
      error = 'Destination is required.'
      return
    }
    busy = true
    error = ''
    try {
      const result = (await invoke('git:cloneHandoff', {
        url: gitUrl.trim(),
        destination: destination.trim()
      })) as { command: string; args: string[]; destination: string; repoName: string }
      handoff = result
      terminalId = `git-clone-${crypto.randomUUID()}`
      showTerminal = true
      minimized = false
      exitCode = undefined
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to start clone.'
    } finally {
      busy = false
    }
  }

  async function handleExit(code: number): Promise<void> {
    exitCode = code
    if (code === 0 && handoff) {
      try {
        // Verify clone succeeded and create project via regular local flow
        const folder = handoff.destination
        const name = folder.split('/').filter(Boolean).pop() ?? handoff.repoName ?? folder
        const project = (await invoke('project:create', {
          name,
          path: folder,
          source: 'local',
          changeTrackingMode: 'git'
        })) as Project
        await onProjectCreated(project)
        resetState()
        onClose()
      } catch (e) {
        error = e instanceof Error ? e.message : 'Clone succeeded but project could not be added.'
      }
    }
  }

  function handleMinimize(): void {
    minimized = true
  }
  function handleExpand(): void {
    minimized = false
  }
  function handleDockClose(): void {
    if (exitCode === undefined) return
    resetState()
    onClose()
  }
</script>

{#if showTerminal && handoff}
  <DockableModal
    open={open}
    title={exitCode === undefined ? `Cloning ${handoff.repoName}` : exitCode === 0 ? `${handoff.repoName} cloned` : `Clone failed`}
    minimized={minimized}
    closable={exitCode !== undefined}
    onMinimize={handleMinimize}
    onClose={handleDockClose}
    onExpand={handleExpand}
  >
    {#snippet dock()}
      <div class="flex items-center gap-1 rounded-xl border bg-surface p-1.5 shadow-xl">
        <button
          class="rounded-lg px-2 py-1 text-[0.625rem] font-semibold uppercase tracking-wide text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="Show clone task"
          title="Show clone task"
          onclick={handleExpand}
        >
          Clone
        </button>
        <span class="h-5 w-px bg-border"></span>
        <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-elevated">
          <GitBranch size={14} class="text-muted" />
        </span>
        {#if exitCode !== undefined}
          <span class="h-5 w-px bg-border"></span>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
            aria-label="Close clone task"
            title="Close clone task"
            onclick={handleDockClose}
          >
            ✕
          </button>
        {/if}
      </div>
    {/snippet}

    <div class="space-y-3">
      <div class="overflow-hidden rounded-xl border bg-surface">
        <div class="flex items-center justify-between gap-3 border-b px-3 py-2">
          <div class="flex min-w-0 items-center gap-2">
            <GitBranch size={14} class="shrink-0 text-muted" />
            <span class="truncate text-xs font-medium">{handoff.repoName}</span>
            <code class="truncate font-mono text-[0.625rem] text-dimmed">
              $ {handoff.command} {handoff.args.join(' ')}
            </code>
          </div>
          {#if exitCode === undefined}
            <span class="flex shrink-0 items-center gap-1 text-[0.625rem] font-medium text-info">
              <Loader2 size={11} class="animate-spin" /> Cloning
            </span>
          {:else if exitCode === 0}
            <span class="flex shrink-0 items-center gap-1 text-[0.625rem] font-medium text-success">Done</span>
          {:else}
            <span class="flex shrink-0 items-center gap-1 text-[0.625rem] font-medium text-danger">Exited {exitCode}</span>
          {/if}
        </div>
        <div class="h-64 overflow-hidden">
          <ProviderLoginTerminal
            terminalId={terminalId}
            command={handoff.command}
            args={handoff.args}
            onExit={(code) => void handleExit(code)}
          />
        </div>
      </div>
      {#if error}
        <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
      {/if}
      <p class="text-[0.6875rem] text-dimmed">
        {exitCode === undefined
          ? 'Clone is running — you can minimize and keep working. Errors appear in the terminal.'
          : exitCode === 0
            ? 'Project will be added automatically.'
            : 'Clone failed — check the terminal output above, then close and retry.'}
      </p>
    </div>
  </DockableModal>
{:else}
  <Modal open={open} title="Clone Git Repository" onClose={handleClose}>
    <form
      class="space-y-4"
      onsubmit={(e: SubmitEvent) => {
        e.preventDefault()
        void startClone()
      }}
    >
      <div>
        <label class="mb-1 block text-xs font-medium text-muted" for="git-clone-url">Git URL</label>
        <input
          id="git-clone-url"
          type="text"
          class="w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground placeholder:text-dimmed"
          placeholder="https://github.com/org/repo.git or git@github.com:org/repo.git"
          bind:value={gitUrl}
          autocomplete="off"
          spellcheck={false}
        />
        <p class="mt-1 text-xs text-dimmed">Supports https and ssh (git@host:owner/repo).</p>
      </div>
      <div>
        <label class="mb-1 block text-xs font-medium text-muted" for="git-clone-dest">Clone to</label>
        <div class="flex gap-2">
          <input
            id="git-clone-dest"
            type="text"
            class="flex-1 rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground placeholder:text-dimmed"
            placeholder="~/ .config/pillardash/codeinoven/projects-gh/<repo>"
            bind:value={destination}
            oninput={() => (userEditedDestination = true)}
            autocomplete="off"
            spellcheck={false}
          />
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-lg border bg-surface px-3 py-2 text-sm text-foreground transition-colors hover:bg-elevated"
            title="Choose destination folder"
            aria-label="Choose destination folder"
            onclick={() => void pickDestination()}
          >
            <FolderInput size={14} /> Browse
          </button>
        </div>
        {#if destination}
          <p class="mt-1 truncate text-xs text-dimmed" title={destination}>{destination}</p>
        {:else}
          <p class="mt-1 text-xs text-dimmed">Default: {APP_NAME} config dir projects-gh/&lt;repo&gt;.</p>
        {/if}
      </div>
      {#if error}
        <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
      {/if}
    </form>

    {#snippet footer()}
      <button
        type="button"
        class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
        title="Cancel"
        onclick={handleClose}
      >
        Cancel
      </button>
      <button
        type="button"
        class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
        disabled={busy || !gitUrl.trim() || !destination.trim()}
        title="Clone repository"
        onclick={() => void startClone()}
      >
        {#if busy}
          <span class="flex items-center gap-1.5"><Loader2 size={14} class="animate-spin" /> Starting…</span>
        {:else}
          Clone
        {/if}
      </button>
    {/snippet}
  </Modal>
{/if}
