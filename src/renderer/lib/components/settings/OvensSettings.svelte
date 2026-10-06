<script lang="ts">
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { randomOvenAppearance } from '$lib/oven-appearance'
  import { getIconSvgDataUrl } from '$lib/project-svg-icons'
  import { flashElement } from '$lib/reveal-flash'
  import { ovenSetupStore } from '$lib/stores/oven-setup.svelte'
  import { ovens } from '$lib/stores/ovens.svelte'
  import { settingsUiState } from '$lib/stores/settings-ui.svelte'
  import { formatDateTime } from '$shared/date-time-format'
  import { ovenSetupActionLabel } from '$shared/oven-setup-policy'
  import {
    LOCAL_OVEN_ID,
    ovenHarnessIdForCommand,
    parseOvenAddress,
    type Oven,
    type OvenConnectionStatus,
    type OvenHarnessInventoryItem,
    type OvenIcon,
    type OvenProbe,
    type OvenState,
    type SaveOvenInput
  } from '$shared/ovens'
  import type { CustomIcon } from '$shared/types'
  import {
    AlertCircle,
    Boxes,
    Cable,
    CheckCircle2,
    Circle,
    Clock,
    Cpu,
    HardDrive,
    Loader2,
    MemoryStick,
    Monitor,
    Pencil,
    Plug,
    Plus,
    RefreshCw,
    Star,
    Terminal,
    Trash2
  } from '@lucide/svelte'
  import { onDestroy, onMount } from 'svelte'
  import { toast } from 'svelte-sonner'
  import type { Attachment } from 'svelte/attachments'
  import { getCustomSvgDataUrl } from '../../../../lib/custom-svg'
  import SecretVisibilityButton from '../shared/SecretVisibilityButton.svelte'
  import SettingsDisclosure from '../shared/SettingsDisclosure.svelte'
  import SettingsEntry from '../shared/SettingsEntry.svelte'
  import SettingsStatusBadge from '../shared/SettingsStatusBadge.svelte'
  import type { MenuItem } from '../shared/ThreadDropdown.svelte'
  import ThreadDropdown from '../shared/ThreadDropdown.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import Modal from '../ui/Modal.svelte'

  const fieldClass = 'w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground'

  interface Props {
    /** Open the app's own harness settings, where Local harnesses are managed. */
    onOpenHarnessSettings: () => void
  }

  let { onOpenHarnessSettings }: Props = $props()
  let ovenState = $state.raw<OvenState | null>(null)
  let health = $state<Record<string, OvenConnectionStatus>>({})
  let folded = $state<Record<string, boolean>>({})
  let checking = $state('')
  let refreshGeneration = 0
  let connectionResult = $state<OvenConnectionStatus | null>(null)
  let probes = $state<Record<string, OvenProbe>>({})
  let setupComplete = $state<Record<string, boolean>>({})
  let busy = $state('')
  let error = $state('')
  let modalError = $state('')
  let editing = $state<Oven | null>(null)
  let editorOpen = $state(false)
  let agentOpen = $state(false)
  let name = $state('')
  let pendingIcon = $state<{ path: string; dataUrl: string } | undefined>()
  let clearImage = $state(false)
  let icon = $state<OvenIcon>('server')
  let customSvg = $state<string | undefined>()
  let customIcons = $state<CustomIcon[]>([])
  let color = $state('#22c55e')
  /**
   * The appearance the editor treats as unchanged: the saved values when editing,
   * or the random pair picked for a new Oven. Comparing against this is what
   * decides whether the Reset control is offered.
   */
  let baselineIcon = $state<OvenIcon>('server')
  let baselineColor = $state('#22c55e')
  let address = $state('ubuntu@')
  let authentication = $state<SaveOvenInput['connection']['authentication']>('agent')
  let identityFile = $state('')
  let identityValidation = $state('')
  let privateKey = $state('')
  let passphrase = $state('')
  let password = $state('')
  let showPassword = $state(false)
  let showPassphrase = $state(false)
  let publicKey = $state('')
  let pendingRemoval = $state<Oven | null>(null)
  let pendingHarnessRemoval = $state<{ ovenId: string; harnessId: string; command: string } | null>(
    null
  )
  let harnessBusy = $state('')
  let timezoneBusy = $state('')
  const hasAppearance = $derived(
    Boolean(
      color !== baselineColor ||
      icon !== baselineIcon ||
      customSvg !== editing?.customSvg ||
      pendingIcon ||
      clearImage
    )
  )

  function message(value: unknown): string {
    return value instanceof Error ? value.message : 'The Oven operation failed.'
  }

  /** The platform name an Oven reports, spelled the way a person reads it. */
  function ovenPlatformName(platform: string | undefined): string {
    if (platform === 'darwin') return 'macOS'
    if (platform === 'win32') return 'Windows'
    if (platform === 'linux') return 'Linux'
    return platform ?? ''
  }

  /** The architecture an Oven reports, shortened to its familiar name. */
  function ovenArchitectureName(architecture: string | undefined): string {
    if (!architecture) return ''
    if (['arm64', 'aarch64'].includes(architecture)) return 'ARM64'
    if (['x64', 'x86_64'].includes(architecture)) return 'x86-64'
    return architecture
  }

  /**
   * Everything an Oven row can do, behind one menu.
   *
   * Setup stays its own button: it is the reason the row exists and the action
   * the user reaches for. The occasional actions live here rather than pushing
   * that button around the header.
   */
  function ovenMenuItems(oven: Oven): MenuItem[] {
    const items: MenuItem[] = []
    if (ovenState?.defaultOvenId !== oven.id)
      items.push({
        label: 'Set as default',
        icon: Star,
        disabled: Boolean(busy),
        onClick: () => void setDefaultOven(oven.id)
      })
    items.push({ label: 'Edit Oven', icon: Pencil, onClick: () => openEditor(oven) })
    if (oven.id !== LOCAL_OVEN_ID) {
      items.push({ label: 'separator:clock', divider: true })
      items.push({
        label: 'Match your time zone',
        icon: Clock,
        disabled: Boolean(busy) || Boolean(timezoneBusy),
        onClick: () => void syncTimezone(oven)
      })
      items.push({ label: 'separator:remove', divider: true })
      items.push({
        label: 'Remove Oven',
        icon: Trash2,
        danger: true,
        onClick: () => (pendingRemoval = oven)
      })
    }
    return items
  }

  /** Make an Oven the default, then republish the registry to every surface. */
  async function setDefaultOven(id: string): Promise<void> {
    if (busy) return
    try {
      await invoke('oven:setDefault', id)
      await load()
    } catch (failure) {
      error = message(failure)
    }
  }

  let dragOvenId = $state<string | null>(null)
  let dropTarget = $state<{ id: string; position: 'before' | 'after' } | null>(null)

  /** Local is pinned first, so only remote Ovens are dragged. */
  function canDragOven(oven: Oven): boolean {
    return oven.kind === 'ssh'
  }

  function startOvenDrag(event: DragEvent, oven: Oven): void {
    if (!canDragOven(oven)) return
    dragOvenId = oven.id
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      // A private type keeps the reorder out of every text/drop handler that
      // watches the document; the id itself is read from component state.
      event.dataTransfer.setData('application/x-cio-oven', oven.id)
    }
  }

  function hoverOven(event: DragEvent, oven: Oven): void {
    if (!dragOvenId || !canDragOven(oven) || oven.id === dragOvenId) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    const row = event.currentTarget as HTMLElement
    const bounds = row.getBoundingClientRect()
    const position = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
    dropTarget = { id: oven.id, position }
  }

  function endOvenDrag(): void {
    dragOvenId = null
    dropTarget = null
  }

  /** Persist the order the drag produced and republish it to every surface. */
  async function dropOven(event: DragEvent): Promise<void> {
    event.preventDefault()
    const dragged = dragOvenId
    const target = dropTarget
    endOvenDrag()
    if (!dragged || !target || !ovenState || busy) return
    const before = ovenState.ovens.filter((oven) => oven.kind === 'ssh').map((oven) => oven.id)
    const next = before.filter((id) => id !== dragged)
    const at = next.indexOf(target.id)
    if (at < 0) return
    next.splice(target.position === 'before' ? at : at + 1, 0, dragged)
    if (next.every((id, index) => id === before[index])) return
    busy = 'reorder'
    try {
      ovenState = await invoke('oven:reorder', next)
      ovens.adopt(ovenState)
    } catch (failure) {
      error = message(failure)
    } finally {
      busy = ''
    }
  }

  /** One installed harness's occasional actions, behind the badge it belongs to. */
  function harnessMenuItems(ovenId: string, item: OvenHarnessInventoryItem): MenuItem[] {
    const busyNow = Boolean(harnessBusy)
    return [
      {
        label: `Update ${item.command}`,
        icon: RefreshCw,
        disabled: busyNow || item.health !== 'healthy',
        onClick: () => void updateHarness(ovenId, item.harnessId)
      },
      { label: 'separator:harness', divider: true },
      {
        label: `Uninstall ${item.command}`,
        icon: Trash2,
        danger: true,
        disabled: busyNow,
        onClick: () =>
          (pendingHarnessRemoval = {
            ovenId,
            harnessId: item.harnessId,
            command: item.command
          })
      }
    ]
  }

  /** Put an Oven's clock on this computer's zone, and say what the Oven did. */
  async function syncTimezone(oven: Oven): Promise<void> {
    if (timezoneBusy || busy) return
    timezoneBusy = oven.id
    try {
      const result = await invoke('oven:timezone:sync', oven.id)
      if (result.status === 'updated') toast.success(result.message)
      else toast.info(result.message)
    } catch (failure) {
      toast.error(message(failure))
    } finally {
      timezoneBusy = ''
    }
  }

  async function load(): Promise<void> {
    try {
      ovenState = await invoke('oven:state')
      // Publishing what was just read is what makes a saved icon or colour, a
      // new Oven, or a manual order show up on every other surface at once.
      ovens.adopt(ovenState)
      folded = Object.fromEntries(ovenState.ovens.map((oven) => [oven.id, folded[oven.id] ?? true]))
      for (const oven of ovenState.ovens) {
        if (
          oven.connectionStatus &&
          oven.connectionStatus.checkedAt >= (health[oven.id]?.checkedAt ?? 0)
        )
          health = { ...health, [oven.id]: oven.connectionStatus }
      }
      void refreshSetupStatuses(ovenState)
      void refreshHealth(ovenState)
      void ovens.ensureInventory(LOCAL_OVEN_ID)
    } catch (failure) {
      error = message(failure)
    }
  }
  onMount(() => {
    void load()
  })

  let lastOvenFocus = 0
  /**
   * Reveal the Oven another surface asked for: expand it, bring it into view,
   * and flash it.
   *
   * An attachment rather than an `$effect` because this reacts to a request, not
   * to derived state, and running it from the list's own update means it also
   * lands when the request arrived before the registry finished loading (the
   * `ovenState` argument changes and the attachment runs again).
   */
  function revealOven(
    focus: { id: string; sequence: number } | null,
    state: OvenState | null
  ): Attachment<HTMLDivElement> {
    return () => {
      if (!focus || !state || focus.sequence === lastOvenFocus) return
      if (!state.ovens.some((oven) => oven.id === focus.id)) return
      lastOvenFocus = focus.sequence
      folded = { ...folded, [focus.id]: false }
      requestAnimationFrame(() => {
        const element = document.getElementById(`oven-row-${focus.id}`)
        if (!element) return
        element.scrollIntoView({ behavior: 'smooth', block: 'center' })
        flashElement(element)
      })
    }
  }

  async function refreshSetupStatuses(state: OvenState): Promise<void> {
    const remote = state.ovens.filter((oven) => oven.kind === 'ssh')
    for (let offset = 0; offset < remote.length; offset += 3) {
      const batch = await Promise.all(
        remote.slice(offset, offset + 3).map(async (oven) => {
          const operation = await invoke('oven:setup:status', oven.id).catch(() => null)
          return [
            oven.id,
            operation?.setupComplete === true || operation?.status === 'succeeded'
          ] as const
        })
      )
      setupComplete = { ...setupComplete, ...Object.fromEntries(batch) }
    }
  }

  onDestroy(() => {
    refreshGeneration++
  })
  async function refreshHealth(state: OvenState): Promise<void> {
    const generation = ++refreshGeneration
    // Two entries per batch, one request at a time; no parallel SSH processes.
    for (let offset = 0; offset < state.ovens.length; offset += 2) {
      for (const oven of state.ovens.slice(offset, offset + 2)) {
        if (generation !== refreshGeneration) return
        checking = oven.id
        try {
          let result: OvenConnectionStatus
          if (oven.kind === 'ssh') {
            try {
              const probe = await invoke('oven:probe', oven.id)
              if (generation !== refreshGeneration) return
              probes = { ...probes, [oven.id]: probe }
              result = {
                state: 'connected',
                checkedAt: Date.now(),
                specs: probe.specs ?? health[oven.id]?.specs
              }
            } catch {
              result = await invoke('oven:connectionHealth', oven.id)
            }
          } else {
            result = await invoke('oven:connectionHealth', oven.id)
          }
          if (generation !== refreshGeneration) return
          health = {
            ...health,
            [oven.id]: { ...result, specs: result.specs ?? health[oven.id]?.specs }
          }
        } catch (failure) {
          if (generation !== refreshGeneration) return
          health = {
            ...health,
            [oven.id]: {
              state: 'disconnected',
              checkedAt: Date.now(),
              error: message(failure),
              specs: health[oven.id]?.specs
            }
          }
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    if (generation === refreshGeneration) checking = ''
  }
  function bytes(value: number): string {
    return (value / 1024 ** 3).toFixed(1) + ' GiB'
  }

  /** A duration in seconds as a short "3d 4h" / "4h 12m" / "12m" phrase. */
  function formatUptime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return ''
    const days = Math.floor(seconds / 86_400)
    const hours = Math.floor((seconds % 86_400) / 3_600)
    const minutes = Math.floor((seconds % 3_600) / 60)
    if (days > 0) return `${days}d ${hours}h`
    if (hours > 0) return `${hours}h ${minutes}m`
    return `${minutes}m`
  }
  function openEditor(oven?: Oven): void {
    pendingIcon = undefined
    clearImage = false
    editing = oven ?? null
    connectionResult = null
    name = oven?.name ?? ''
    const appearance = oven ? { icon: oven.icon, color: oven.color } : randomOvenAppearance()
    baselineIcon = appearance.icon
    baselineColor = appearance.color
    icon = appearance.icon
    customSvg = oven?.customSvg
    void invoke('icon-library:list')
      .then((icons) => (customIcons = icons))
      .catch((failure: unknown) => (modalError = message(failure)))
    color = appearance.color
    const connection = oven?.connection
    const host = connection?.host.includes(':') ? `[${connection.host}]` : connection?.host
    address = connection
      ? `${connection.user ? `${connection.user}@` : ''}${host}${connection.port !== 22 ? `:${connection.port}` : ''}`
      : 'ubuntu@'
    authentication = connection?.authentication ?? 'agent'
    identityFile = connection?.identityFile ?? ''
    identityValidation = ''
    privateKey = ''
    passphrase = ''
    password = ''
    showPassword = false
    showPassphrase = false
    publicKey = ''
    modalError = ''
    editorOpen = true
  }

  async function uploadImage(): Promise<void> {
    try {
      const path = await invoke('dialog:pickImage')
      if (!path) return
      const dataUrl = await invoke('file:readAsDataUrl', path)
      if (dataUrl) {
        pendingIcon = { path, dataUrl }
        clearImage = false
      }
    } catch (failure) {
      modalError = message(failure)
    }
  }

  function resetAppearance(): void {
    icon = baselineIcon
    customSvg = editing?.customSvg
    color = baselineColor
    pendingIcon = undefined
    clearImage = false
  }

  function closeEditor(): void {
    if (busy) return
    editorOpen = false
    privateKey = ''
    passphrase = ''
    password = ''
    showPassword = false
    showPassphrase = false
    publicKey = ''
  }

  function draftInput(): SaveOvenInput {
    return {
      ...(editing ? { id: editing.id } : {}),
      name,
      icon,
      ...(pendingIcon ? { imagePath: pendingIcon.path } : {}),
      clearImage,
      ...(customSvg ? { customSvg } : {}),
      color,
      connection: {
        ...parseOvenAddress(address),
        authentication,
        ...(authentication === 'identity' ? { identityFile } : {})
      },
      ...(privateKey.trim() ? { privateKey } : {}),
      ...(passphrase ? { passphrase } : {}),
      ...(authentication === 'password' && password ? { password } : {}),
      ...(publicKey.trim() ? { publicKey } : {})
    }
  }
  async function testConnection(): Promise<void> {
    if (busy) return
    busy = 'test'
    modalError = ''
    connectionResult = null
    try {
      if (authentication === 'identity')
        identityFile = await invoke('oven:validateIdentity', identityFile)
      connectionResult = await invoke('oven:testConnection', {
        ...draftInput(),
        name: name.trim() || 'Connection test'
      })
      if (editing) health = { ...health, [editing.id]: connectionResult }
    } catch (failure) {
      modalError = message(failure)
    } finally {
      busy = ''
    }
  }

  async function save(): Promise<void> {
    if (busy) return
    modalError = ''
    busy = 'save'
    try {
      if (authentication === 'identity') {
        identityFile = await invoke('oven:validateIdentity', identityFile)
        identityValidation = 'Private-key file validated.'
      }
      const input = draftInput()
      const saved = await invoke('oven:save', input)
      if (connectionResult?.state === 'connected')
        health = { ...health, [saved.id]: connectionResult }
      privateKey = ''
      passphrase = ''
      password = ''
      showPassword = false
      showPassphrase = false
      publicKey = ''
      await load()
      editorOpen = false
    } catch (failure) {
      modalError = message(failure)
    } finally {
      busy = ''
    }
  }

  async function validateIdentity(): Promise<void> {
    const candidate = identityFile
    identityValidation = ''
    if (!candidate.trim()) return
    try {
      const validated = await invoke('oven:validateIdentity', candidate)
      if (identityFile === candidate) {
        identityFile = validated
        identityValidation = 'Private-key file validated.'
      }
    } catch (failure) {
      if (identityFile === candidate) identityValidation = message(failure)
    }
  }

  async function pickIdentity(): Promise<void> {
    try {
      const path = await invoke('dialog:pickFile')
      if (!path) return
      identityFile = path
      await validateIdentity()
    } catch (failure) {
      identityValidation = message(failure)
    }
  }

  async function openOvenSetup(oven: Oven): Promise<void> {
    ovenSetupStore.show(oven.id)
    const operation = await invoke('oven:setup:status', oven.id).catch(() => null)
    setupComplete = {
      ...setupComplete,
      [oven.id]: operation?.setupComplete === true || operation?.status === 'succeeded'
    }
  }

  /** Reveal a freshly registered Oven so its setup action is immediately visible. */
  async function onAgentRegistered(ovenId: string): Promise<void> {
    folded = { ...folded, [ovenId]: false }
    await load()
  }

  async function remove(): Promise<void> {
    if (!pendingRemoval || busy) return
    busy = 'remove'
    error = ''
    try {
      ovenState = await invoke('oven:remove', pendingRemoval.id)
      ovens.adopt(ovenState)
      pendingRemoval = null
    } catch (failure) {
      error = message(failure)
    } finally {
      busy = ''
    }
  }

  async function updateHarness(ovenId: string, harnessId: string): Promise<void> {
    if (harnessBusy) return
    harnessBusy = `${ovenId}:${harnessId}`
    error = ''
    try {
      const item = await invoke('oven:harness:update', ovenId, harnessId)
      const probe = probes[ovenId]
      if (probe?.inventory)
        probes = {
          ...probes,
          [ovenId]: {
            ...probe,
            inventory: probe.inventory.map((row) => (row.harnessId === harnessId ? item : row))
          }
        }
    } catch (failure) {
      error = message(failure)
    } finally {
      harnessBusy = ''
    }
  }

  async function uninstallHarness(): Promise<void> {
    if (!pendingHarnessRemoval || harnessBusy) return
    const pending = pendingHarnessRemoval
    harnessBusy = `${pending.ovenId}:${pending.harnessId}`
    error = ''
    try {
      const item = await invoke('oven:harness:uninstall', pending.ovenId, pending.harnessId)
      const probe = probes[pending.ovenId]
      if (probe?.inventory)
        probes = {
          ...probes,
          [pending.ovenId]: {
            ...probe,
            inventory: probe.inventory.map((row) =>
              row.harnessId === pending.harnessId ? item : row
            )
          }
        }
      pendingHarnessRemoval = null
    } catch (failure) {
      error = message(failure)
    } finally {
      harnessBusy = ''
    }
  }
</script>

<div class="p-6 pb-24">
  <div class="mb-6 flex items-start justify-between gap-4">
    <div>
      <h1 class="text-xl font-bold tracking-tight">Ovens</h1>
      <p class="mt-0.5 text-sm text-muted">This computer and your remote SSH environments.</p>
    </div>
    <div class="flex items-center gap-2">
      <button
        type="button"
        class="flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-3 text-xs font-medium text-foreground hover:bg-overlay"
        onclick={() => (agentOpen = true)}
      >
        <Terminal size={14} /> Add via agent
      </button>
      <button
        type="button"
        class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover"
        onclick={() => openEditor()}
      >
        <Plus size={14} /> New Oven
      </button>
    </div>
  </div>
  {#if error}<p class="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
      {error}
    </p>{/if}
  {#if !ovenState}
    <p class="flex items-center gap-2 text-sm text-muted">
      <Loader2 size={14} class="animate-spin" /> Loading Ovens
    </p>
  {:else}
    <div class="space-y-3" role="list" {@attach revealOven(settingsUiState.ovenFocus, ovenState)}>
      {#each ovenState.ovens as oven (oven.id)}
        {@const probe = probes[oven.id]}
        {@const checkingNow = checking === oven.id}
        {@const state = health[oven.id]?.state}
        <div
          class="relative rounded-xl"
          id={`oven-row-${oven.id}`}
          role="listitem"
          draggable={canDragOven(oven)}
          ondragstart={(event) => startOvenDrag(event, oven)}
          ondragover={(event) => hoverOven(event, oven)}
          ondrop={(event) => void dropOven(event)}
          ondragend={endOvenDrag}
        >
          {#if dropTarget?.id === oven.id}
            <span
              class={'pointer-events-none absolute inset-x-0 h-0.5 rounded-full bg-primary ' +
                (dropTarget.position === 'before' ? 'top-0' : 'bottom-0')}
              aria-hidden="true"
            ></span>
          {/if}
          <SettingsEntry expanded={!folded[oven.id]}>
            <div class="grid grid-cols-1 items-center gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
              <div class="flex min-w-0 items-center gap-3">
                {#if oven.id === LOCAL_OVEN_ID}
                  <Monitor size={20} class="shrink-0 text-muted" />
                {:else}
                  <img
                    src={oven.imageDataUrl ??
                      (oven.customSvg
                        ? getCustomSvgDataUrl(oven.customSvg, oven.color)
                        : getIconSvgDataUrl(oven.icon, oven.color))}
                    alt=""
                    class="h-5 w-5 object-contain"
                  />
                {/if}
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="truncate text-sm font-semibold">{oven.name}</span>
                    {#if ovenState.defaultOvenId === oven.id}<span
                        class="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary"
                        >Default</span
                      >{/if}
                    <SettingsStatusBadge
                      label={checkingNow
                        ? 'Checking…'
                        : state === 'connected'
                          ? 'Connected'
                          : state === 'disconnected'
                            ? 'Disconnected'
                            : 'Not checked'}
                      classes={checkingNow
                        ? 'border-info/30 bg-info/10 text-info'
                        : state === 'connected'
                          ? 'border-success/30 bg-success/10 text-success'
                          : state === 'disconnected'
                            ? 'border-danger/30 bg-danger/10 text-danger'
                            : 'border-border bg-elevated text-dimmed'}
                    >
                      {#if checkingNow}<Loader2
                          size={12}
                          class="shrink-0 animate-spin"
                        />{:else if state === 'connected'}<CheckCircle2
                          size={12}
                          class="shrink-0"
                        />{:else if state === 'disconnected'}<AlertCircle
                          size={12}
                          class="shrink-0"
                        />{:else}<Circle size={12} class="shrink-0" />{/if}
                    </SettingsStatusBadge>
                  </div>
                </div>
              </div>
              <div class="flex items-center gap-2">
                {#if busy === oven.id}<Loader2 size={14} class="animate-spin text-muted" />{/if}
                {#if oven.id === LOCAL_OVEN_ID}
                  <button
                    type="button"
                    class="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium hover:bg-elevated disabled:opacity-50"
                    disabled={Boolean(busy)}
                    onclick={onOpenHarnessSettings}
                  >
                    <Plug size={12} />Setup
                  </button>
                  {#if ovenState?.defaultOvenId !== oven.id}
                    <button
                      type="button"
                      class="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium hover:bg-elevated disabled:opacity-50"
                      disabled={Boolean(busy)}
                      onclick={() => void setDefaultOven(oven.id)}
                    >
                      <Star size={12} />Set as default
                    </button>
                  {/if}
                {:else}
                  <button
                    type="button"
                    class="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium hover:bg-elevated disabled:opacity-50"
                    disabled={Boolean(busy)}
                    onclick={() => void openOvenSetup(oven)}
                  >
                    <Terminal size={12} />{ovenSetupActionLabel(
                      ovenSetupStore.completed[oven.id] || setupComplete[oven.id] || false
                    )}</button
                  >
                  <ThreadDropdown
                    items={ovenMenuItems(oven)}
                    title={`${oven.name} actions`}
                    ariaLabel={`${oven.name} actions`}
                  />
                {/if}
                <SettingsDisclosure
                  expanded={!folded[oven.id]}
                  title={`${folded[oven.id] ? 'Show' : 'Hide'} ${oven.name} details`}
                  onclick={() => (folded[oven.id] = !folded[oven.id])}
                />
              </div>
            </div>
            {#if !folded[oven.id]}
              <div class="mt-3 space-y-3 border-t border-border pt-3">
                {#if health[oven.id]?.specs}
                  {@const specs = health[oven.id].specs!}
                  {@const usedPercent =
                    specs.diskBytes > 0
                      ? Math.max(
                          0,
                          Math.min(100, (1 - specs.diskAvailableBytes / specs.diskBytes) * 100)
                        )
                      : 0}
                  <dl class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <div class="space-y-1.5">
                      <dt class="flex items-center gap-1.5 text-xs text-dimmed">
                        <Monitor size={14} />System
                      </dt>
                      <dd class="text-sm font-medium text-foreground">
                        {ovenPlatformName(specs.platform)}
                      </dd>
                      <dd class="text-xs text-muted">{specs.hostname}</dd>
                      {#if formatUptime(specs.uptimeSeconds)}
                        <dd class="text-xs text-muted">Up {formatUptime(specs.uptimeSeconds)}</dd>
                      {/if}
                    </div>
                    <div class="space-y-1.5">
                      <dt class="flex items-center gap-1.5 text-xs text-dimmed">
                        <Cpu size={14} />Processor
                      </dt>
                      <dd class="text-sm font-medium text-foreground">
                        {specs.cpuCount} logical cores
                      </dd>
                      <dd class="text-xs text-muted">
                        {ovenArchitectureName(specs.architecture)}
                      </dd>
                    </div>
                    <div class="space-y-1.5">
                      <dt class="flex items-center gap-1.5 text-xs text-dimmed">
                        <MemoryStick size={14} />Memory
                      </dt>
                      <dd class="text-sm font-medium text-foreground">
                        {bytes(specs.memoryBytes)}
                      </dd>
                      <dd class="text-xs text-muted">Total RAM</dd>
                    </div>
                    <div class="space-y-1.5">
                      <dt class="flex items-center gap-1.5 text-xs text-dimmed">
                        <HardDrive size={14} />Storage
                      </dt>
                      <dd class="text-sm font-medium text-foreground">{bytes(specs.diskBytes)}</dd>
                      <dd class="text-xs text-muted">
                        {bytes(specs.diskAvailableBytes)} available
                      </dd>
                      <dd
                        class="h-1 overflow-hidden rounded-full bg-elevated"
                        title={usedPercent.toFixed(0) + '% storage used'}
                      >
                        <div
                          class="h-full rounded-full bg-primary"
                          style:width={usedPercent + '%'}
                        ></div>
                      </dd>
                    </div>
                  </dl>
                {/if}
                {#if health[oven.id]?.error}<p class="text-xs text-danger" role="status">
                    {health[oven.id].error}
                  </p>{/if}
                {#if probe || health[oven.id]?.specs}
                  {@const nodeVersion =
                    probe?.nodeVersion ?? health[oven.id]?.specs?.nodeVersion ?? null}
                  <dl class="grid grid-cols-1 gap-4 border-t border-border pt-3 sm:grid-cols-3">
                    <div class="space-y-1.5">
                      <dt class="flex items-center gap-1.5 text-xs text-dimmed">
                        <Terminal size={14} />Service runtime
                      </dt>
                      <dd class="text-sm font-medium text-foreground">
                        {nodeVersion ? `Node.js ${nodeVersion.replace(/^v/, '')}` : 'Not installed'}
                      </dd>
                      <dd class="text-xs text-muted">
                        {probe
                          ? [
                              ovenPlatformName(probe.platform),
                              ovenArchitectureName(probe.architecture),
                              `${probe.activeRuns} active run${probe.activeRuns === 1 ? '' : 's'}`
                            ]
                              .filter(Boolean)
                              .join(' · ')
                          : oven.kind === 'local'
                            ? `${ovenPlatformName(health[oven.id]?.specs?.platform)} · this computer`
                            : 'No service has answered from this Oven yet.'}
                      </dd>
                      {#if probe?.timezone}
                        <dd class="text-xs text-muted">Time zone: {probe.timezone}</dd>
                      {/if}
                    </div>
                    <div class="space-y-1.5">
                      <dt class="flex items-center gap-1.5 text-xs text-dimmed">
                        <Boxes size={14} />Installed harnesses
                      </dt>
                      <dd class="flex flex-wrap items-center gap-1.5">
                        {#if oven.kind === 'local'}
                          {@const localItems = ovens.inventory(LOCAL_OVEN_ID) ?? []}
                          {#each localItems.filter((item) => item.health === 'healthy') as item (item.harnessId)}
                            <span
                              class="flex items-center rounded-lg bg-elevated p-1"
                              title={`${item.command}${
                                item.installedVersion ? ` ${item.installedVersion}` : ''
                              }`}
                            >
                              <AgentIcon agentId={item.harnessId} label={item.command} size={14} />
                            </span>
                          {/each}
                          {#if !localItems.some((item) => item.health === 'healthy')}
                            <span class="text-xs text-muted">None found</span>
                          {/if}
                        {:else if probe?.inventory?.length}
                          {#each probe.inventory.filter((item) => item.health !== 'missing') as item (item.harnessId)}
                            <span
                              class="flex items-center gap-0.5 rounded-lg bg-elevated py-0.5 pr-0.5 pl-1.5"
                              title={`${item.command}${
                                item.installedVersion ? ` ${item.installedVersion}` : ''
                              }${item.health === 'healthy' ? '' : ` · ${item.health}`}`}
                            >
                              <AgentIcon agentId={item.harnessId} label={item.command} size={14} />
                              {#if harnessBusy === `${oven.id}:${item.harnessId}`}
                                <Loader2 size={11} class="animate-spin text-muted" />
                              {:else}
                                <ThreadDropdown
                                  vertical
                                  items={harnessMenuItems(oven.id, item)}
                                  title={`${item.command} actions`}
                                  ariaLabel={`${item.command} actions`}
                                />
                              {/if}
                            </span>
                          {/each}
                          {#if !probe.inventory.some((item) => item.health !== 'missing')}
                            <span class="text-xs text-muted">None found</span>
                          {/if}
                        {:else if probe?.harnesses.some((harness) => harness.path)}
                          {#each probe.harnesses.filter((harness) => harness.path) as harness (harness.command)}
                            <span
                              class="flex items-center rounded-lg bg-elevated p-1"
                              title={harness.command}
                            >
                              <AgentIcon
                                agentId={ovenHarnessIdForCommand(harness.command) ??
                                  harness.command}
                                label={harness.command}
                                size={14}
                              />
                            </span>
                          {/each}
                        {:else if probe}
                          <span class="text-xs text-muted">None found</span>
                        {:else}
                          <span class="text-xs text-muted"
                            >Connect to read this Oven's harnesses.</span
                          >
                        {/if}
                      </dd>
                    </div>
                    <div>
                      <div class="space-y-1.5">
                        <dt class="flex items-center gap-1.5 text-xs text-dimmed">
                          <Cable size={14} />Connection Info
                        </dt>
                        <dd class="flex flex-col gap-1.5">
                          <p class="mt-0.5 truncate text-xs text-muted">
                            {#if oven.kind === 'local'}
                              This computer
                            {:else}
                              {oven.connection?.user ? `${oven.connection.user}@` : ''}{oven
                                .connection?.host}:{oven.connection?.port}
                            {/if}
                          </p>
                          <p class="mt-0.5 truncate text-xs text-muted">
                            Added {formatDateTime(oven.createdAt)}
                          </p>
                        </dd>
                      </div>
                    </div>
                  </dl>
                {/if}
              </div>
            {/if}
          </SettingsEntry>
        </div>
      {/each}
    </div>
    <p class="mt-4 text-xs text-dimmed">
      Service setup uses your SSH account and requires Node.js 22 or later on the Oven. Trust the
      host in OpenSSH before connecting.
    </p>
  {/if}
</div>

<Modal open={editorOpen} title={editing ? 'Edit Oven' : 'New Oven'} onClose={closeEditor} size="lg">
  <form
    id="oven-editor"
    class="space-y-4"
    onsubmit={(event) => {
      event.preventDefault()
      void save()
    }}
  >
    {#if modalError}<p class="text-sm text-danger" role="alert">{modalError}</p>{/if}
    {#if editorOpen}
      {#await import('../shared/AppearancePicker.svelte') then { default: AppearancePicker }}
        <AppearancePicker
          {name}
          {color}
          iconType={customSvg ? undefined : icon}
          {customSvg}
          {customIcons}
          allowCustomSvg
          resetPlacement="footer"
          fallbackIconUrl={pendingIcon?.dataUrl ?? (clearImage ? null : editing?.imageDataUrl)}
          onUploadImage={() => void uploadImage()}
          onColorChange={(next) => (color = next ?? '#22c55e')}
          onIconTypeChange={(next) => {
            icon = next ?? 'server'
            pendingIcon = undefined
            clearImage = true
          }}
          onCustomSvgChange={(next) => {
            customSvg = next
            pendingIcon = undefined
            clearImage = true
          }}
          onAddCustomIcon={async (svg) => {
            const saved = await invoke('icon-library:add', svg)
            customIcons = [...customIcons, saved]
          }}
          onReset={resetAppearance}
        />
      {/await}
    {/if}
    <label class="block space-y-1 text-xs font-medium text-muted"
      >Name<input
        class={fieldClass}
        bind:value={name}
        required
        maxlength={80}
        placeholder="Ubuntu workspace"
      /></label
    >
    <div class="space-y-2">
      <p class="text-xs font-medium text-muted">Connection preset</p>
      <div class="flex flex-wrap gap-2">
        {#each ['ubuntu@', 'root@', 'SSH alias'] as preset (preset)}
          <button
            type="button"
            class="rounded-lg border px-2 py-1 text-xs hover:bg-elevated"
            onclick={() => (address = preset === 'SSH alias' ? '' : preset)}
            >{preset === 'SSH alias' ? preset : `ssh ${preset}ip`}</button
          >
        {/each}
      </div>
      <label class="block space-y-1 text-xs font-medium text-muted"
        >SSH address<input
          class={fieldClass}
          bind:value={address}
          required
          placeholder="ssh ubuntu@192.0.2.10"
        /></label
      >
      <p class="text-xs text-dimmed">
        Use user@host, user@host:port, or a host alias from your SSH config.
      </p>
    </div>
    <label class="block space-y-1 text-xs font-medium text-muted"
      >Authentication
      <select class={fieldClass} bind:value={authentication}>
        <option value="password" disabled={!ovenState?.secureStorageAvailable}>Password</option>
        <option value="agent">SSH config / agent</option>
        <option value="identity">Existing identity file</option>
        <option value="vault" disabled={!ovenState?.secureStorageAvailable}
          >Private key in vault</option
        >
      </select>
    </label>
    {#if authentication === 'password'}
      <label class="block space-y-1 text-xs font-medium text-muted"
        >SSH account password {editing?.hasPassword ? '(saved, leave blank to keep)' : ''}
        <div class="relative">
          <input
            class={`${fieldClass} pr-10`}
            type={showPassword ? 'text' : 'password'}
            bind:value={password}
            autocomplete="new-password"
            required={!editing?.hasPassword}
            placeholder="Password for your SSH user"
          />
          <div class="absolute inset-y-0 right-1 flex items-center">
            <SecretVisibilityButton
              revealed={showPassword}
              title={showPassword ? 'Hide password' : 'Show password'}
              onclick={() => (showPassword = !showPassword)}
            />
          </div>
        </div>
      </label>
      <p class="text-xs text-dimmed">
        Your password is encrypted in the secret vault and used when connecting.
      </p>
    {:else if authentication === 'identity'}
      <div class="space-y-2">
        <label class="block space-y-1 text-xs font-medium text-muted"
          >Identity file<input
            class={fieldClass}
            bind:value={identityFile}
            oninput={() => (identityValidation = '')}
            onblur={() => void validateIdentity()}
            required
            placeholder="Pick or paste your SSH private-key path"
          /></label
        >
        <button
          type="button"
          class="rounded-lg border px-3 py-2 text-sm"
          onclick={() => void pickIdentity()}>Choose private-key file</button
        >
        {#if identityValidation}<p class="text-xs text-muted" role="status">
            {identityValidation}
          </p>{/if}
      </div>
    {:else if authentication === 'vault'}
      <label class="block space-y-1 text-xs font-medium text-muted"
        >Private key {editing?.hasPrivateKey ? '(stored, leave blank to keep)' : ''}<textarea
          class={`${fieldClass} min-h-28 font-mono`}
          bind:value={privateKey}
          required={!editing?.hasPrivateKey}
          autocomplete="off"
          spellcheck="false"
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea></label
      >
      <label class="block space-y-1 text-xs font-medium text-muted"
        >Passphrase, optional {editing?.hasPassphrase ? '(stored, leave blank to keep)' : ''}
        <div class="relative">
          <input
            class={`${fieldClass} pr-10`}
            type={showPassphrase ? 'text' : 'password'}
            bind:value={passphrase}
            autocomplete="new-password"
          />
          <div class="absolute inset-y-0 right-1 flex items-center">
            <SecretVisibilityButton
              revealed={showPassphrase}
              title={showPassphrase ? 'Hide passphrase' : 'Show passphrase'}
              onclick={() => (showPassphrase = !showPassphrase)}
            />
          </div>
        </div></label
      >
    {/if}
    {#if authentication !== 'password'}
      <label class="block space-y-1 text-xs font-medium text-muted"
        >Public key, optional {editing?.hasPublicKey ? '(stored)' : ''}<textarea
          class={`${fieldClass} font-mono`}
          bind:value={publicKey}
          autocomplete="off"
          spellcheck="false"
          disabled={!ovenState?.secureStorageAvailable}
          placeholder="ssh-ed25519 ..."></textarea></label
      >
    {/if}
    <p class="text-xs text-dimmed">
      Passwords, imported keys and key passphrases are encrypted in the secret vault.
      {#if authentication !== 'password'}The matching public key must already be authorized on the
        Oven.{/if}
    </p>
    {#if connectionResult}<p
        class="text-xs"
        class:text-success={connectionResult.state === 'connected'}
        class:text-danger={connectionResult.state === 'disconnected'}
        role="status"
      >
        {connectionResult.state === 'connected'
          ? 'Connected successfully.'
          : connectionResult.error}
      </p>{/if}
  </form>
  {#snippet footer()}
    <div class="flex w-full flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        {#if hasAppearance}
          <button
            type="button"
            class="rounded-lg px-3 py-2 text-sm text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
            title="Reset appearance"
            disabled={Boolean(busy)}
            onclick={resetAppearance}
          >
            Reset
          </button>
        {:else}<span></span>{/if}
        <button
          type="button"
          class="rounded-lg border px-3 py-2 text-sm hover:bg-elevated disabled:opacity-50"
          disabled={Boolean(busy)}
          onclick={() => void testConnection()}
          >{#if busy === 'test'}<Loader2 size={14} class="animate-spin" />{/if}Test connection</button
        >
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          data-modal-dismiss
          class="rounded-lg border px-3 py-2 text-sm hover:bg-elevated"
          disabled={Boolean(busy)}
          onclick={closeEditor}>Cancel</button
        >
        <button
          type="submit"
          form="oven-editor"
          data-modal-primary
          class="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-on-primary disabled:opacity-50"
          disabled={Boolean(busy)}
          >{#if busy === 'save'}<Loader2 size={14} class="animate-spin" />{/if}Save Oven</button
        >
      </div>
    </div>
  {/snippet}
</Modal>

<ConfirmDialog
  open={Boolean(pendingRemoval)}
  title="Remove Oven?"
  confirmLabel="Remove Oven"
  busy={busy === 'remove'}
  onCancel={() => (pendingRemoval = null)}
  onConfirm={remove}
>
  <p>Remove {pendingRemoval?.name} and its saved credentials from this computer?</p>
  <p>Its remote files and service remain on the host. Remote runs will continue there.</p>
</ConfirmDialog>

<ConfirmDialog
  open={Boolean(pendingHarnessRemoval)}
  title="Uninstall harness?"
  confirmLabel="Uninstall"
  busy={Boolean(harnessBusy)}
  onCancel={() => (pendingHarnessRemoval = null)}
  onConfirm={uninstallHarness}
>
  <p>Uninstall {pendingHarnessRemoval?.command} from this Oven?</p>
  <p>
    The harness may remove its own configuration or credentials. CodeInOven checks that it is not
    running before uninstalling it.
  </p>
</ConfirmDialog>

{#if agentOpen}
  {#await import('./OvenAgentModal.svelte') then { default: OvenAgentModal }}
    <OvenAgentModal
      open={agentOpen}
      onClose={() => (agentOpen = false)}
      onRegistered={(ovenId) => void onAgentRegistered(ovenId)}
    />
  {/await}
{/if}
