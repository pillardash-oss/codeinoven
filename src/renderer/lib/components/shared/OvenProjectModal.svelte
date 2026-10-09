<script lang="ts">
  import { ChevronDown, Loader2, Plus, Server } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import { invoke } from '$lib/ipc.svelte'
  import { ovenMarkUrl } from '$lib/stores/ovens.svelte'
  import { settingsUiState } from '$lib/stores/settings-ui.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { folderBaseName } from '$lib/project-location'
  import type { Oven, OvenProbe, OvenState } from '$shared/ovens'
  import type { Project } from '$shared/types'
  import EmptyState from '../ui/EmptyState.svelte'
  import Modal from '../ui/Modal.svelte'
  import OvenFileBrowser from './OvenFileBrowser.svelte'

  interface Props {
    open: boolean
    onClose: () => void
    onProjectCreated: (project: Project) => void | Promise<void>
  }

  let { open, onClose, onProjectCreated }: Props = $props()

  let ovenState = $state.raw<OvenState | null>(null)
  let loadingOvens = $state(false)
  let loadError = $state('')
  let selectedOvenId = $state('')
  let probeHome = $state('')
  let probing = $state(false)
  let probeError = $state('')
  let selectedPath = $state('')
  let adding = $state(false)
  let error = $state('')

  /** Only remote Ovens can host a project; Local Folder is its own option. */
  let remoteOvens = $derived((ovenState?.ovens ?? []).filter((oven) => oven.kind === 'ssh'))
  let selectedOven = $derived(remoteOvens.find((oven) => oven.id === selectedOvenId) ?? null)

  /**
   * The project takes its name from the folder the user picked, so there is
   * nothing to type. A bare filesystem root has no last segment and therefore
   * no name, which keeps the root itself from being added as a project.
   */
  let projectName = $derived(namedFolderSegment(selectedPath))
  let canAdd = $derived(
    !adding && Boolean(selectedOvenId) && Boolean(probeHome) && Boolean(projectName)
  )

  /** The folder's last path segment, or an empty string when it has none. */
  function namedFolderSegment(folder: string): string {
    return /^[\\/]+$/u.test(folder) ? '' : folderBaseName(folder)
  }

  async function loadOvens(): Promise<void> {
    loadingOvens = true
    loadError = ''
    try {
      ovenState = await invoke('oven:state')
      // Preselect the default Oven when it is remote, so the folder picker is
      // ready without a first click; otherwise wait for a choice.
      if (!selectedOvenId) {
        const preferred = ovenState.ovens.find(
          (oven) => oven.id === ovenState?.defaultOvenId && oven.kind === 'ssh'
        )
        selectedOvenId = preferred?.id ?? ''
      }
    } catch (failure) {
      loadError = failure instanceof Error ? failure.message : 'Ovens could not be loaded.'
    } finally {
      loadingOvens = false
    }
  }

  /** The Oven user's home directory, as the probe reports it. */
  function homeFromProbe(probe: OvenProbe): string {
    return typeof probe.home === 'string' ? probe.home.trim() : ''
  }

  async function probeOven(ovenId: string): Promise<void> {
    probing = true
    probeError = ''
    probeHome = ''
    selectedPath = ''
    try {
      const probe = await invoke('oven:probe', ovenId)
      const home = homeFromProbe(probe)
      if (home) {
        probeHome = home
        selectedPath = home
      } else {
        probeError = `${selectedOven?.name ?? 'This Oven'} could not be reached. Check the connection and try again.`
      }
    } catch (failure) {
      probeError = failure instanceof Error ? failure.message : 'This Oven could not be reached.'
    } finally {
      probing = false
    }
  }

  // Open the picker fresh each time, and probe the chosen Oven for its home so
  // the browser starts where the Oven user actually lives.
  $effect(() => {
    if (!open) return
    void loadOvens()
  })

  $effect(() => {
    const ovenId = selectedOvenId
    if (!open || !ovenId) return
    void probeOven(ovenId)
  })

  function reset(): void {
    selectedOvenId = ''
    probeHome = ''
    probing = false
    probeError = ''
    selectedPath = ''
    error = ''
    loadError = ''
    adding = false
    ovenState = null
  }

  function requestNewOven(): void {
    settingsUiState.requestNewOven()
    workspaceState.navigateToSettings?.('ovens')
    onClose()
  }

  function ovenAddress(oven: Oven): string {
    return oven.connection?.host ?? oven.name
  }

  async function addProject(): Promise<void> {
    if (!canAdd || !selectedOven) return
    adding = true
    error = ''
    try {
      const project = await invoke('project:create', {
        name: projectName,
        path: selectedPath.trim(),
        source: 'ssh',
        host: ovenAddress(selectedOven),
        ovenId: selectedOven.id,
        changeTrackingMode: 'manual'
      })
      await onProjectCreated(project)
      onClose()
      reset()
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'The project could not be added.'
    } finally {
      adding = false
    }
  }
</script>

<Modal {open} size="lg" title="Project from an Oven" {onClose}>
  {#if loadError}
    <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{loadError}</p>
  {:else if loadingOvens || !ovenState}
    <p class="flex items-center gap-2 py-6 text-sm text-muted">
      <Loader2 size={15} class="animate-spin" />
      Loading Ovens…
    </p>
  {:else if remoteOvens.length === 0}
    <EmptyState
      icon={Server}
      title="No Ovens yet"
      description="An Oven is a machine CodeInOven runs agents on over SSH. Add one to start a project there."
    >
      {#snippet action()}
        <button
          type="button"
          class="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
          title="Add a new Oven in Settings"
          onclick={requestNewOven}
        >
          <Plus size={15} />
          Create a New Oven
        </button>
      {/snippet}
    </EmptyState>
  {:else}
    <div class="space-y-4">
      <div>
        <label class="mb-1 block text-xs font-medium text-muted" for="oven-project-oven">
          Oven
        </label>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            id="oven-project-oven"
            class="flex h-9 w-full items-center gap-2 rounded-lg border bg-elevated px-3 text-left text-sm text-foreground transition-colors hover:bg-overlay"
            aria-label="Choose an Oven"
            title="Choose an Oven"
          >
            {#if selectedOven}
              {#if ovenMarkUrl(selectedOven)}
                <img class="h-4 w-4 shrink-0" alt="" src={ovenMarkUrl(selectedOven)} />
              {:else}
                <Server size={14} class="shrink-0 text-muted" />
              {/if}
              <span class="min-w-0 flex-1 truncate">{selectedOven.name}</span>
            {:else}
              <Server size={14} class="shrink-0 text-muted" />
              <span class="min-w-0 flex-1 truncate text-muted">Choose an Oven</span>
            {/if}
            <ChevronDown size={14} class="shrink-0 text-muted" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="bottom"
              align="start"
              sideOffset={6}
              collisionPadding={8}
              class="z-60 max-h-72 w-[var(--bits-floating-anchor-width)] overflow-y-auto rounded-xl border bg-surface p-1 shadow-lg"
            >
              {#each remoteOvens as oven (oven.id)}
                <DropdownMenu.Item
                  class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                  title={`Use ${oven.name}`}
                  onSelect={() => (selectedOvenId = oven.id)}
                >
                  {#if ovenMarkUrl(oven)}
                    <img class="h-4 w-4 shrink-0" alt="" src={ovenMarkUrl(oven)} />
                  {:else}
                    <Server size={14} class="shrink-0 text-muted" />
                  {/if}
                  <span class="min-w-0 flex-1 truncate">{oven.name}</span>
                  {#if oven.id === ovenState?.defaultOvenId}
                    <span class="shrink-0 text-xs text-dimmed">Default</span>
                  {/if}
                </DropdownMenu.Item>
              {/each}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      {#if probing}
        <p class="flex items-center gap-2 py-2 text-sm text-muted">
          <Loader2 size={15} class="animate-spin" />
          Connecting to {selectedOven?.name ?? 'the Oven'}…
        </p>
      {:else if probeError}
        <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
          {probeError}
        </p>
      {:else if selectedOvenId && probeHome}
        <div>
          <span class="mb-1 block text-xs font-medium text-muted">
            Folder on {selectedOven?.name ?? 'the Oven'}
          </span>
          <OvenFileBrowser ovenId={selectedOvenId} root={probeHome} bind:value={selectedPath} />
        </div>
      {/if}

      {#if error}
        <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</p>
      {/if}
    </div>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      title="Cancel"
      onclick={onClose}
    >
      Cancel
    </button>
    {#if remoteOvens.length > 0}
      <button
        type="button"
        class="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
        title="Add this Oven project"
        disabled={!canAdd}
        onclick={() => void addProject()}
      >
        {#if adding}
          <Loader2 size={15} class="animate-spin" />
        {/if}
        Add project
      </button>
    {/if}
  {/snippet}
</Modal>
