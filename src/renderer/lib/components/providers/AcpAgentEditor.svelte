<script lang="ts">
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioImage from '@pdslng/cio-icon/CioImage.svelte'
  import CioPlug from '@pdslng/cio-icon/CioPlug.svelte'
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
    icon: string | undefined
    iconDark: string | undefined
  }

  const ICON_VARIANTS = [
    { key: 'icon', label: 'Icon' },
    { key: 'iconDark', label: 'Dark icon' }
  ] as const

  type IconVariant = (typeof ICON_VARIANTS)[number]['key']

  const PANEL_STORAGE_KEY = `${APP_SLUG}.acpAgentPanel.v1`
  const ICON_ACCEPT = ACP_AGENT_ICON_TYPES.join(',')
  const FIELD = 'h-9 w-full border bg-elevated px-3 text-sm outline-none focus:border-primary'
  const MONO_FIELD = `${FIELD} font-mono`
  const UPLOAD = 'flex h-7 items-center border bg-surface px-2 text-[0.6875rem]'
  const CLEAR = 'flex h-7 items-center px-2 text-[0.6875rem] text-muted'
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
      icon: source?.icon,
      iconDark: source?.iconDark
    }
  }

  // svelte-ignore state_referenced_locally
  let draft = $state<Draft>(createDraft(agent))
  let docked = $state(false)
  /** Variant whose file is being read; both uploads wait for it. */
  let reading = $state<IconVariant | null>(null)
  let error = $state('')
  let confirmingDelete = $state(false)
  let removing = $state(false)
  let fileInput: HTMLInputElement | null = null

  /** Attach the hidden picker without `bind:this`, so the click is a call. */
  function captureFileInput(node: HTMLInputElement): () => void {
    fileInput = node
    return () => {
      if (fileInput === node) fileInput = null
    }
  }
  let pendingVariant = $state<IconVariant>('icon')

  const title = $derived(agent ? `Edit ${agent.name}` : 'Add ACP agent')
  const chipStatus = $derived(draft.name.trim() || draft.command.trim() || 'Untitled agent')
  const filled = $derived(draft.name.trim() !== '' && draft.command.trim() !== '')
  const canSave = $derived(!acpAgentsStore.saving && reading === null && filled)
  /** A save or upload failure, else whatever the last read of the agents said. */
  const message = $derived(error || acpAgentsStore.error)

  function splitArgs(value: string): string[] {
    return value.split(/\s+/u).filter(Boolean)
  }

  function applyPreset(preset: AcpKnownAgent): void {
    draft.name = preset.name
    draft.command = preset.command
    draft.args = preset.args.join(' ')
  }

  function pickIcon(variant: IconVariant): void {
    if (reading !== null) return
    pendingVariant = variant
    error = ''
    fileInput?.click()
  }

  function clearIcon(variant: IconVariant): void {
    draft[variant] = undefined
  }

  function readAsDataUrl(file: File): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () =>
        typeof reader.result === 'string'
          ? resolve(reader.result)
          : reject(new Error('That image could not be read.'))
      reader.onerror = () => reject(new Error('That image could not be read.'))
      reader.readAsDataURL(file)
    })
  }

  /** Same rules as the vendor icon picker: image format, 256 KiB, 2048px edge. */
  async function chooseIcon(event: Event): Promise<void> {
    const input = event.currentTarget
    if (!(input instanceof HTMLInputElement)) return
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    const variant = pendingVariant
    reading = variant
    error = ''
    try {
      if (!ACP_AGENT_ICON_TYPES.includes(file.type) || file.size > MAX_ACP_AGENT_ICON_BYTES) {
        throw new Error('Choose an SVG, PNG, JPEG, WebP or GIF of at most 256 KiB.')
      }
      const data = await readAsDataUrl(file)
      const image = new Image()
      image.src = data
      await image.decode()
      if (image.naturalWidth > 2048 || image.naturalHeight > 2048) {
        throw new Error('Choose an icon no larger than 2048 × 2048.')
      }
      draft[variant] = data
    } catch (iconFailure) {
      error = iconFailure instanceof Error ? iconFailure.message : 'That image could not be read.'
    } finally {
      reading = null
    }
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
        icon: draft.icon ?? null,
        iconDark: draft.iconDark ?? null
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
    <button type="button" data-modal-dismiss class="{SECONDARY} ml-auto" onclick={close}>
      Cancel
    </button>
    <button type="button" class={PRIMARY} disabled={!canSave} onclick={save}>Save</button>
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

    <label class="block space-y-1 text-xs font-medium">
      <span>Agent name</span>
      <input class={FIELD} placeholder="Cursor" required bind:value={draft.name} />
    </label>

    <label class="block space-y-1 text-xs font-medium">
      <span>Command</span>
      <input class={MONO_FIELD} placeholder="cursor-agent" required bind:value={draft.command} />
    </label>

    <label class="block space-y-1 text-xs font-medium">
      <span>Arguments</span>
      <input class={MONO_FIELD} placeholder="acp" required bind:value={draft.args} />
    </label>

    <div class="space-y-1.5">
      <p class="text-xs font-medium">Icon</p>
      {#each ICON_VARIANTS as variant (variant.key)}
        {@const preview = draft[variant.key]}
        <div class="flex items-center gap-2 border bg-elevated p-2">
          <span class="flex h-9 w-9 shrink-0 items-center justify-center border bg-raised">
            {#if preview}
              <img src={preview} alt="" class="h-full w-full object-contain" />
            {:else}
              <CioImage size={16} class="text-dimmed" />
            {/if}
          </span>
          <span class="min-w-0 flex-1 truncate text-xs font-medium">{variant.label}</span>
          <button type="button" class={UPLOAD} onclick={() => pickIcon(variant.key)}>
            {preview ? 'Replace' : 'Upload'}
          </button>
          {#if preview}
            <button type="button" class={CLEAR} onclick={() => clearIcon(variant.key)}>Clear</button
            >
          {/if}
        </div>
      {/each}
      <input
        type="file"
        {@attach captureFileInput}
        hidden
        accept={ICON_ACCEPT}
        onchange={chooseIcon}
      />
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
