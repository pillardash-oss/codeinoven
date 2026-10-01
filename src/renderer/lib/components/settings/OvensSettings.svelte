<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import {
    Loader2,
    Plus,
    CheckCircle2,
    AlertCircle,
    Circle,
    Cpu,
    MemoryStick,
    HardDrive,
    Monitor,
    Terminal
  } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import {
    LOCAL_OVEN_ID,
    parseOvenAddress,
    type Oven,
    type OvenIcon,
    type OvenState,
    type OvenProbe,
    type OvenConnectionStatus,
    type SaveOvenInput
  } from '$shared/ovens'
  import SecretVisibilityButton from '../shared/SecretVisibilityButton.svelte'
  import SettingsStatusBadge from '../shared/SettingsStatusBadge.svelte'
  import SettingsDisclosure from '../shared/SettingsDisclosure.svelte'
  import SettingsEntry from '../shared/SettingsEntry.svelte'
  import Modal from '../ui/Modal.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import { getIconSvgDataUrl } from '$lib/project-svg-icons'
  import { getCustomSvgDataUrl } from '../../../../lib/custom-svg'
  import type { CustomIcon } from '$shared/types'

  const fieldClass = 'w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground'
  let ovenState = $state.raw<OvenState | null>(null)
  let health = $state<Record<string, OvenConnectionStatus>>({})
  let folded = $state<Record<string, boolean>>({})
  let checking = $state('')
  let refreshGeneration = 0
  let connectionResult = $state<OvenConnectionStatus | null>(null)
  let probes = $state<Record<string, OvenProbe>>({})
  let busy = $state('')
  let error = $state('')
  let modalError = $state('')
  let editing = $state<Oven | null>(null)
  let editorOpen = $state(false)
  let name = $state('')
  let icon = $state<OvenIcon>('server')
  let customSvg = $state<string | undefined>()
  let customIcons = $state<CustomIcon[]>([])
  let color = $state('#22c55e')
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

  function message(value: unknown): string {
    return value instanceof Error ? value.message : 'The Oven operation failed.'
  }
  async function load(): Promise<void> {
    try {
      ovenState = await invoke('oven:state')
      folded = Object.fromEntries(ovenState.ovens.map((oven) => [oven.id, folded[oven.id] ?? true]))
      for (const oven of ovenState.ovens) {
        if (
          oven.connectionStatus &&
          oven.connectionStatus.checkedAt >= (health[oven.id]?.checkedAt ?? 0)
        )
          health = { ...health, [oven.id]: oven.connectionStatus }
      }
      void refreshHealth(ovenState)
    } catch (failure) {
      error = message(failure)
    }
  }
  onMount(() => {
    void load()
  })

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
          const result = await invoke('oven:connectionHealth', oven.id)
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
  function openEditor(oven?: Oven): void {
    editing = oven ?? null
    connectionResult = null
    name = oven?.name ?? ''
    icon = oven?.icon ?? 'server'
    customSvg = oven?.customSvg
    void invoke('icon-library:list')
      .then((icons) => (customIcons = icons))
      .catch((failure: unknown) => (modalError = message(failure)))
    color = oven?.color ?? '#22c55e'
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

  async function connect(oven: Oven): Promise<void> {
    if (busy) return
    busy = oven.id
    error = ''
    try {
      const probe = await invoke('oven:install', oven.id)
      probes = { ...probes, [oven.id]: probe }
    } catch (failure) {
      error = `${oven.name}: ${message(failure)}`
    } finally {
      busy = ''
    }
  }

  async function remove(): Promise<void> {
    if (!pendingRemoval || busy) return
    busy = 'remove'
    error = ''
    try {
      ovenState = await invoke('oven:remove', pendingRemoval.id)
      pendingRemoval = null
    } catch (failure) {
      error = message(failure)
    } finally {
      busy = ''
    }
  }
</script>

<div class="p-6 pb-24">
  <div class="mb-6 flex items-start justify-between gap-4">
    <div>
      <h1 class="text-xl font-bold tracking-tight">Ovens</h1>
      <p class="mt-0.5 text-sm text-muted">This computer and your remote SSH environments.</p>
    </div>
    <button
      type="button"
      class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover"
      onclick={() => openEditor()}
    >
      <Plus size={14} /> New Oven
    </button>
  </div>
  {#if error}<p class="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
      {error}
    </p>{/if}
  {#if !ovenState}
    <p class="flex items-center gap-2 text-sm text-muted">
      <Loader2 size={14} class="animate-spin" /> Loading Ovens
    </p>
  {:else}
    <div class="space-y-3">
      {#each ovenState.ovens as oven (oven.id)}
        {@const probe = probes[oven.id]}
        {@const checkingNow = checking === oven.id}
        {@const state = health[oven.id]?.state}
        <SettingsEntry expanded={!folded[oven.id]}>
          <div class="grid grid-cols-1 items-center gap-3 lg:grid-cols-[minmax(0,1fr)_10rem_auto]">
            <div class="flex min-w-0 items-center gap-3">
              <img
                src={oven.customSvg
                  ? getCustomSvgDataUrl(oven.customSvg, oven.color)
                  : getIconSvgDataUrl(oven.icon, oven.color)}
                alt=""
                class="h-5 w-5"
              />
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="truncate text-sm font-semibold">{oven.name}</span>
                  {#if ovenState.defaultOvenId === oven.id}<span
                      class="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">Default</span
                    >{/if}
                </div>
              </div>
            </div>
            <div class="min-w-0">
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
            <div class="flex flex-wrap items-center gap-2">
              {#if busy === oven.id}<Loader2 size={14} class="animate-spin text-muted" />{/if}
              {#if ovenState.defaultOvenId !== oven.id}
                <button
                  type="button"
                  class="rounded-lg border px-2.5 py-1.5 text-xs hover:bg-elevated"
                  disabled={Boolean(busy)}
                  onclick={() =>
                    void invoke('oven:setDefault', oven.id)
                      .then((next) => (ovenState = next))
                      .catch((failure: unknown) => (error = message(failure)))}>Set default</button
                >
              {/if}
              {#if oven.id !== LOCAL_OVEN_ID}
                <button
                  type="button"
                  class="rounded-lg border px-2.5 py-1.5 text-xs hover:bg-elevated disabled:opacity-50"
                  disabled={Boolean(busy)}
                  onclick={() => void connect(oven)}>Set up service</button
                >
                <button
                  type="button"
                  class="rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-elevated"
                  onclick={() => openEditor(oven)}>Edit</button
                >
                <button
                  type="button"
                  class="rounded-lg px-2 py-1.5 text-xs text-danger hover:bg-danger/10"
                  onclick={() => (pendingRemoval = oven)}>Remove</button
                >
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
              <p class="mt-0.5 truncate text-xs text-muted">
                {oven.kind === 'local'
                  ? 'This computer'
                  : `${oven.connection?.user ? `${oven.connection.user}@` : ''}${oven.connection?.host}:${oven.connection?.port} · SSH`}
              </p>
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
                      {specs.platform.toLowerCase() === 'darwin'
                        ? 'macOS'
                        : specs.platform === 'win32'
                          ? 'Windows'
                          : specs.platform}
                    </dd>
                    <dd class="text-xs text-muted">{specs.hostname}</dd>
                  </div>
                  <div class="space-y-1.5">
                    <dt class="flex items-center gap-1.5 text-xs text-dimmed">
                      <Cpu size={14} />Processor
                    </dt>
                    <dd class="text-sm font-medium text-foreground">
                      {specs.cpuCount} logical cores
                    </dd>
                    <dd class="text-xs text-muted">
                      {['arm64', 'aarch64'].includes(specs.architecture)
                        ? 'ARM64'
                        : ['x64', 'x86_64'].includes(specs.architecture)
                          ? 'x86-64'
                          : specs.architecture}
                    </dd>
                  </div>
                  <div class="space-y-1.5">
                    <dt class="flex items-center gap-1.5 text-xs text-dimmed">
                      <MemoryStick size={14} />Memory
                    </dt>
                    <dd class="text-sm font-medium text-foreground">{bytes(specs.memoryBytes)}</dd>
                    <dd class="text-xs text-muted">Total RAM</dd>
                  </div>
                  <div class="space-y-1.5">
                    <dt class="flex items-center gap-1.5 text-xs text-dimmed">
                      <HardDrive size={14} />Storage
                    </dt>
                    <dd class="text-sm font-medium text-foreground">{bytes(specs.diskBytes)}</dd>
                    <dd class="text-xs text-muted">{bytes(specs.diskAvailableBytes)} available</dd>
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
                <div class="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <Terminal size={14} /><span>Service runtime</span><span
                    class="font-medium text-foreground"
                    >{specs.nodeVersion
                      ? 'Node.js ' + specs.nodeVersion.replace(/^v/, '')
                      : 'Not installed'}</span
                  >
                </div>
              {/if}
              {#if health[oven.id]?.error}<p class="text-xs text-danger" role="status">
                  {health[oven.id].error}
                </p>{/if}
              {#if probe}
                <div class="space-y-1 pl-8 text-xs text-muted">
                  <p>
                    {probe.platform} · {probe.architecture} · Node {probe.nodeVersion} · {probe.activeRuns}
                    active runs
                  </p>
                  <p>
                    Installed harnesses: {probe.harnesses
                      .filter((harness) => harness.path)
                      .map((harness) => harness.command)
                      .join(', ') || 'None found'}
                  </p>
                </div>
              {/if}
            </div>
          {/if}
        </SettingsEntry>
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
    <label class="block space-y-1 text-xs font-medium text-muted"
      >Name<input
        class={fieldClass}
        bind:value={name}
        required
        maxlength={80}
        placeholder="Ubuntu workspace"
      /></label
    >
    {#if editorOpen}
      {#await import('../shared/AppearancePicker.svelte') then { default: AppearancePicker }}
        <AppearancePicker
          {name}
          {color}
          iconType={customSvg ? undefined : icon}
          {customSvg}
          {customIcons}
          allowCustomSvg
          onColorChange={(next) => (color = next ?? '#22c55e')}
          onIconTypeChange={(next) => (icon = next ?? 'server')}
          onCustomSvgChange={(next) => (customSvg = next)}
          onAddCustomIcon={async (svg) => {
            const saved = await invoke('icon-library:add', svg)
            customIcons = [...customIcons, saved]
          }}
          onReset={() => {
            icon = 'server'
            customSvg = undefined
            color = '#22c55e'
          }}
        />
      {/await}
    {/if}
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
    <button
      type="button"
      class="mr-auto flex items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-elevated disabled:opacity-50"
      disabled={Boolean(busy)}
      onclick={() => void testConnection()}
      >{#if busy === 'test'}<Loader2 size={14} class="animate-spin" />{/if}Test connection</button
    >
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
