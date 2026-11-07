<script lang="ts">
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioPlug from '@pdslng/cio-icon/CioPlug.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioTrash from '@pdslng/cio-icon/CioTrash.svelte'
  import { ipcErrorMessage } from '$lib/ipc-errors'
  import { acpAgentsStore } from '$lib/stores/acp-agents.svelte'
  import { APP_SLUG } from '$shared/brand'
  import {
    ACP_AGENT_ICON_TYPES,
    MAX_ACP_AGENT_ICON_BYTES,
    type AcpAgentStatus,
    type AcpKnownAgent
  } from '$shared/acp'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import DockableModal from '../ui/DockableModal.svelte'
  import DockRow from '../ui/DockRow.svelte'
  import IconUploadField from '../ui/IconUploadField.svelte'
  import { vendorIconSlugFor } from '$lib/agent-icons/agent-vendor'
  import Switch from '../ui/Switch.svelte'

  /** Add or edit the command that starts one ACP agent. It docks so the
   *  command can be tried in a terminal while the draft stays put. */
  interface Props {
    /** Agent being edited, or null while adding one. Mounted per target. */
    agent: AcpAgentStatus | null
  }

  interface Draft {
    name: string
    command: string
    args: string
    updateCommand: string
    icon: string | undefined
    iconDark: string | undefined
    enabled: boolean
  }

  /** The two artworks an agent can carry, one per theme. */
  const ICON_VARIANTS = [
    { key: 'icon', label: 'Light mode' },
    { key: 'iconDark', label: 'Dark mode' }
  ] as const

  type IconVariant = (typeof ICON_VARIANTS)[number]['key']

  const PANEL_STORAGE_KEY = `${APP_SLUG}.acpAgentPanel.v1`
  const FIELD = 'h-9 w-full border bg-elevated px-3 text-sm outline-none focus:border-primary'
  const MONO_FIELD = `${FIELD} font-mono`
  const SECONDARY = 'h-9 border bg-elevated px-3 text-xs font-medium hover:bg-overlay'
  const PRIMARY = 'flex h-9 items-center gap-1.5 bg-primary px-4 text-xs text-on-primary'
  const DANGER = 'flex h-9 items-center gap-1.5 px-2 text-xs font-medium text-danger'

  let { agent }: Props = $props()

  /** Seeded once per mounted panel, so a collapse keeps the draft. */
  function createDraft(source: AcpAgentStatus | null): Draft {
    return {
      name: source?.name ?? '',
      command: source?.command ?? '',
      args: source?.args.join(' ') ?? '',
      updateCommand: source?.updateCommand ?? '',
      icon: source?.icon,
      iconDark: source?.iconDark,
      enabled: source?.enabled ?? true
    }
  }

  // svelte-ignore state_referenced_locally
  let draft = $state<Draft>(createDraft(agent))
  let docked = $state(false)
  /** Variant whose file is being read; both uploads wait for it. */
  let reading = $state(false)
  let iconTab = $state<IconVariant>('icon')
  let error = $state('')
  let confirmingDelete = $state(false)
  let removing = $state(false)

  const title = $derived(agent ? `Edit ${agent.name}` : 'Add ACP agent')
  const chipStatus = $derived(draft.name.trim() || draft.command.trim() || 'Untitled agent')
  const filled = $derived(draft.name.trim() !== '' && draft.command.trim() !== '')
  const canSave = $derived(!acpAgentsStore.saving && !reading && filled)
  /**
   * What the empty icon preview shows: the vendor the agent's command belongs to,
   * or the app's own vendor mark. A monogram of the name the user typed is not a
   * vendor icon, so it is never the preview.
   */
  const placeholderVendorId = $derived(vendorIconSlugFor(draft.command, draft.name))
  /** A save or upload failure, else whatever the last read of the agents said. */
  const message = $derived(error || acpAgentsStore.error)

  function splitArgs(value: string): string[] {
    return value.split(/\s+/u).filter(Boolean)
  }

  function applyPreset(preset: AcpKnownAgent): void {
    draft.name = preset.name
    draft.command = preset.command
    draft.args = preset.args.join(' ')
    draft.updateCommand = preset.updateCommand ?? ''
  }

  async function save(): Promise<void> {
    if (!canSave) return
    error = ''
    try {
      await acpAgentsStore.save({
        ...(agent ? { id: agent.id } : {}),
        name: draft.name.trim(),
        command: draft.command.trim(),
        args: splitArgs(draft.args),
        updateCommand: draft.updateCommand.trim() || null,
        icon: draft.icon ?? null,
        iconDark: draft.iconDark ?? null,
        enabled: draft.enabled
      })
      acpAgentsStore.closeEditor()
    } catch (saveFailure) {
      error = ipcErrorMessage(saveFailure, 'The ACP agent could not be saved.')
    }
  }

  async function remove(): Promise<void> {
    if (!agent || removing) return
    removing = true
    error = ''
    try {
      await acpAgentsStore.remove(agent.id)
      confirmingDelete = false
      acpAgentsStore.closeEditor()
    } catch (removeFailure) {
      error = ipcErrorMessage(removeFailure, 'The ACP agent could not be removed.')
    } finally {
      removing = false
    }
  }

  function close(): void {
    if (acpAgentsStore.saving) return
    acpAgentsStore.closeEditor()
  }

  function cancelDelete(): void {
    if (removing) return
    confirmingDelete = false
  }

  function onSubmit(event: SubmitEvent): void {
    event.preventDefault()
    void save()
  }

  /** ⌘/Ctrl+Enter saves from any field; plain Enter stays inside the field. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    if (event.repeat || event.isComposing) return
    event.preventDefault()
    void save()
  }
</script>

<DockableModal
  open
  {title}
  minimized={docked}
  closable={!acpAgentsStore.saving}
  onMinimize={() => (docked = true)}
  onClose={close}
  storageKey={PANEL_STORAGE_KEY}
  dragLabel="Drag to move the ACP agent panel"
>
  {#snippet dock()}
    <DockRow storageKey={PANEL_STORAGE_KEY} label="Move docked ACP agent">
      <div class="flex items-center border bg-surface p-1.5 shadow-xl">
        <button
          type="button"
          class="flex items-center gap-2 px-2.5 py-1.5 hover:bg-elevated"
          title="Show the ACP agent form"
          aria-label="Show the ACP agent form ({chipStatus})"
          onclick={() => (docked = false)}
        >
          <CioPlug size={14} class="text-dimmed" />
          <span class="max-w-40 truncate text-[0.6875rem] font-medium">{chipStatus}</span>
        </button>
        <button
          type="button"
          class="flex h-8 w-8 items-center justify-center text-muted hover:bg-elevated"
          title="Close the ACP agent form"
          aria-label="Close the ACP agent form"
          onclick={close}
        >
          <CioClose size={14} />
        </button>
      </div>
    </DockRow>
  {/snippet}

  {#snippet footer()}
    {#if agent}
      <button type="button" class={DANGER} onclick={() => (confirmingDelete = true)}>
        <CioTrash size={13} /> Delete
      </button>
    {/if}
    <button type="button" data-modal-dismiss class={SECONDARY} onclick={close}>Cancel</button>
    <button type="button" class="{PRIMARY} ml-auto" disabled={!canSave} onclick={save}>
      {#if acpAgentsStore.saving}
        <CioSpinner size={13} class="animate-spin" /> Saving…
      {:else}
        Save
      {/if}
    </button>
  {/snippet}

  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <form class="space-y-4" spellcheck="false" onsubmit={onSubmit} onkeydown={onKeydown}>
    <div class="flex flex-wrap items-center gap-1.5">
      <span class="text-xs font-medium">Start from</span>
      {#each acpAgentsStore.knownAgents as preset (preset.name)}
        {@const pick = () => applyPreset(preset)}
        <button type="button" class="h-8 border bg-elevated px-2.5 text-xs" onclick={pick}>
          {preset.name}
        </button>
      {/each}
    </div>

    <div class="flex items-end gap-3">
      <label class="block min-w-0 flex-1 space-y-1 text-xs font-medium">
        <span>Agent name</span>
        <input class={FIELD} placeholder="Cursor" required bind:value={draft.name} />
      </label>
      <div class="flex h-9 shrink-0 items-center gap-2 border bg-surface px-3">
        <span class="text-xs font-medium">Enabled</span>
        <Switch
          checked={draft.enabled}
          onchange={(value) => (draft.enabled = value)}
          aria-label="Offer this agent as a harness"
          title="Turn off to park this agent without deleting it"
        />
      </div>
    </div>

    <label class="block space-y-1 text-xs font-medium">
      <span>Command</span>
      <input class={MONO_FIELD} placeholder="cursor-agent" required bind:value={draft.command} />
    </label>

    <label class="block space-y-1 text-xs font-medium">
      <span>Arguments</span>
      <input class={MONO_FIELD} placeholder="acp" required bind:value={draft.args} />
    </label>

    <label class="block space-y-1 text-xs font-medium">
      <span>Update command</span>
      <input
        class={MONO_FIELD}
        placeholder="cursor-agent update"
        bind:value={draft.updateCommand}
      />
      <span class="block text-[0.625rem] font-normal text-dimmed">
        The vendor's own updater. Update runs it in the terminal, the way a harness updates itself.
      </span>
    </label>

    <div class="space-y-1.5">
      <div
        class="flex w-max items-center gap-0.5 border bg-elevated p-0.5"
        role="tablist"
        aria-label="Icon theme"
      >
        {#each ICON_VARIANTS as variant (variant.key)}
          <button
            type="button"
            role="tab"
            aria-selected={iconTab === variant.key}
            class="px-2.5 py-1 text-[0.6875rem] font-medium transition-colors {iconTab ===
            variant.key
              ? 'bg-surface text-foreground'
              : 'text-muted hover:text-foreground'}"
            title={`Edit the ${variant.label.toLowerCase()} icon`}
            onclick={() => (iconTab = variant.key)}
          >
            {variant.label}
          </button>
        {/each}
      </div>
      {#each ICON_VARIANTS as variant (variant.key)}
        {#if iconTab === variant.key}
          <IconUploadField
            label={variant.label}
            accept={ACP_AGENT_ICON_TYPES}
            maxBytes={MAX_ACP_AGENT_ICON_BYTES}
            value={draft[variant.key]}
            disabled={acpAgentsStore.saving}
            name={draft.name.trim() || 'ACP agent'}
            id={placeholderVendorId}
            hint="SVG or image, up to 256 KiB."
            onselect={(data) => (draft[variant.key] = data)}
            onclear={() => (draft[variant.key] = undefined)}
            onreading={(value) => (reading = value)}
          />
        {/if}
      {/each}
    </div>

    {#if message}<p class="text-xs text-danger">{message}</p>{/if}
  </form>
</DockableModal>

{#if confirmingDelete && agent}
  <ConfirmDialog
    open
    title={`Remove ${agent.name}?`}
    confirmLabel="Remove agent"
    busy={removing}
    onCancel={cancelDelete}
    onConfirm={remove}
  >
    <p>
      {agent.name} stops appearing in the harness list, and any thread pinned to it must pick another
      harness.
    </p>
  </ConfirmDialog>
{/if}
