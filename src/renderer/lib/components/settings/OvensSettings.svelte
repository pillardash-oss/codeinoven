<script lang="ts">
  import { onMount } from 'svelte'
  import { Loader2, Plus } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import {
    LOCAL_OVEN_ID,
    parseOvenAddress,
    type Oven,
    type OvenIcon,
    type OvenState,
    type OvenProbe,
    type SaveOvenInput
  } from '$shared/ovens'
  import Modal from '../ui/Modal.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import { getIconSvgDataUrl } from '$lib/project-svg-icons'
  import { getCustomSvgDataUrl } from '../../../../lib/custom-svg'
  import type { CustomIcon } from '$shared/types'

  const fieldClass = 'w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground'
  let ovenState = $state.raw<OvenState | null>(null)
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
  let privateKey = $state('')
  let passphrase = $state('')
  let publicKey = $state('')
  let pendingRemoval = $state<Oven | null>(null)

  function message(value: unknown): string {
    return value instanceof Error ? value.message : 'The Oven operation failed.'
  }
  async function load(): Promise<void> {
    try {
      ovenState = await invoke('oven:state')
    } catch (failure) {
      error = message(failure)
    }
  }
  onMount(() => {
    void load()
  })

  function openEditor(oven?: Oven): void {
    editing = oven ?? null
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
    privateKey = ''
    passphrase = ''
    publicKey = ''
    modalError = ''
    editorOpen = true
  }

  function closeEditor(): void {
    if (busy === 'save') return
    editorOpen = false
    privateKey = ''
    passphrase = ''
    publicKey = ''
  }

  async function save(): Promise<void> {
    if (busy) return
    modalError = ''
    busy = 'save'
    try {
      const input: SaveOvenInput = {
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
        ...(publicKey.trim() ? { publicKey } : {})
      }
      await invoke('oven:save', input)
      privateKey = ''
      passphrase = ''
      publicKey = ''
      await load()
      editorOpen = false
    } catch (failure) {
      modalError = message(failure)
    } finally {
      busy = ''
    }
  }

  async function connect(oven: Oven, install = false): Promise<void> {
    if (busy) return
    busy = oven.id
    error = ''
    try {
      const probe = install
        ? await invoke('oven:install', oven.id)
        : await invoke('oven:probe', oven.id)
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
    <div class="divide-y rounded-xl border">
      {#each ovenState.ovens as oven (oven.id)}
        {@const probe = probes[oven.id]}
        <div class="space-y-3 p-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
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
                <p class="mt-0.5 truncate text-xs text-muted">
                  {oven.kind === 'local'
                    ? 'This computer'
                    : `${oven.connection?.user ? `${oven.connection.user}@` : ''}${oven.connection?.host}:${oven.connection?.port} · SSH`}
                </p>
              </div>
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
                  onclick={() => void connect(oven)}>Probe</button
                >
                <button
                  type="button"
                  class="rounded-lg border px-2.5 py-1.5 text-xs hover:bg-elevated disabled:opacity-50"
                  disabled={Boolean(busy)}
                  onclick={() => void connect(oven, true)}>Set up service</button
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
            </div>
          </div>
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
        <option value="agent">SSH config / agent</option>
        <option value="identity">Existing identity file</option>
        <option value="vault" disabled={!ovenState?.secureStorageAvailable}
          >Private key in vault</option
        >
      </select>
    </label>
    {#if authentication === 'identity'}
      <label class="block space-y-1 text-xs font-medium text-muted"
        >Identity file<input
          class={fieldClass}
          bind:value={identityFile}
          required
          placeholder="Absolute path to your SSH private key"
        /></label
      >
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
        >Passphrase {editing?.hasPassphrase ? '(stored, leave blank to keep)' : ''}<input
          class={fieldClass}
          type="password"
          bind:value={passphrase}
          autocomplete="new-password"
        /></label
      >
    {/if}
    <label class="block space-y-1 text-xs font-medium text-muted"
      >Public key, optional {editing?.hasPublicKey ? '(stored)' : ''}<textarea
        class={`${fieldClass} font-mono`}
        bind:value={publicKey}
        autocomplete="off"
        spellcheck="false"
        disabled={!ovenState?.secureStorageAvailable}
        placeholder="ssh-ed25519 ..."></textarea></label
    >
    <p class="text-xs text-dimmed">
      Imported keys and passphrases are encrypted in the secret vault. The matching public key must
      already be authorized on the Oven.
    </p>
  </form>
  {#snippet footer()}
    <button
      type="button"
      data-modal-dismiss
      class="rounded-lg border px-3 py-2 text-sm hover:bg-elevated"
      disabled={busy === 'save'}
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
