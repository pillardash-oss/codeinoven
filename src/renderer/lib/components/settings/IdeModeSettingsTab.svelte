<script lang="ts">
  import { DropdownMenu } from 'bits-ui'
  import CioEllipsis from '@pdslng/cio-icon/CioEllipsis.svelte'
  import CioCircle from '@pdslng/cio-icon/CioCircle.svelte'
  import SettingsDisclosure from '../shared/SettingsDisclosure.svelte'
  import SettingsEntry from '../shared/SettingsEntry.svelte'
  import SettingsStatusBadge from '../shared/SettingsStatusBadge.svelte'
  import CardNotice from '../shared/CardNotice.svelte'
  import { ipcErrorMessage } from '$lib/ipc-errors'
  import { onMount } from 'svelte'
  import type { IdeInstallation } from '$shared/editor-ide'
  import CioCode from '@pdslng/cio-icon/CioCode.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioSparkles from '@pdslng/cio-icon/CioSparkles.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import IdeLanguageServerEditor from './IdeLanguageServerEditor.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { copyText } from '$lib/copy-text'
  import { openSetupConversation } from '$lib/utility-setup-thread'
  import { ideServerSetupRequest, ideSetupRequest } from '$shared/ide-setup-request'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import type { AppConfig, AppConfigPatch } from '$shared/types'
  import {
    DEFAULT_IDE_LANGUAGE_SERVERS,
    IDE_SERVER_PACKAGES,
    validateIdeLanguageServers,
    type IdeLanguageServer
  } from '$shared/ide-language-servers'
  interface Props {
    config: AppConfig
    updateConfig: (patch: AppConfigPatch) => Promise<void>
  }
  let { config, updateConfig }: Props = $props()
  let servers = $derived(config.ideLanguageServers ?? DEFAULT_IDE_LANGUAGE_SERVERS)
  let installations = $state.raw<Record<string, IdeInstallation>>({})
  let loadingInstallations = $state(true)
  let checkingUpdates = $state(false)
  let inventorySequence = 0
  async function refreshInstallations(updates = false): Promise<void> {
    const id = ++inventorySequence
    if (updates) checkingUpdates = true
    try {
      const result = await invoke('projectFiles:ide', '', {
        owner: crypto.randomUUID(),
        action: 'inventory',
        path: '',
        query: updates ? 'updates' : undefined
      })
      if (id !== inventorySequence) return
      installations = Object.fromEntries(
        (result.installations ?? []).map((item) => [item.serverId, item])
      )
    } catch (reason) {
      if (id === inventorySequence)
        error = reason instanceof Error ? reason.message : String(reason)
    } finally {
      if (id === inventorySequence) {
        loadingInstallations = false
        checkingUpdates = false
      }
    }
  }
  onMount(() => {
    void refreshInstallations().then(() => refreshInstallations(true))
  })
  function hasUpdate(item: IdeInstallation | undefined): boolean {
    if (!item?.version || !item.latestVersion) return false
    return item.latestVersion.localeCompare(item.version, undefined, { numeric: true }) > 0
  }
  let adding = $state(false)
  let presetId = $state('typescript')
  let editing = $state<IdeLanguageServer | null>(null)
  let expanded = $state<Record<string, boolean>>({})
  let deleting = $state<IdeLanguageServer | null>(null)
  let importing = $state(false)
  let importText = $state('')
  let error = $state('')
  let busy = $state(false)
  let checking = $state<Record<string, boolean>>({})
  let installing = $state<Record<string, boolean>>({})
  let status = $state<Record<string, string>>({})
  const buttonClass =
    'border border-border bg-surface px-2 py-1 text-xs text-foreground hover:bg-elevated disabled:opacity-40'
  async function persist(next: IdeLanguageServer[]): Promise<void> {
    await updateConfig({ ideLanguageServers: validateIdeLanguageServers(next) })
    status = {}
    await refreshInstallations()
  }
  async function saveServer(server: IdeLanguageServer): Promise<void> {
    await persist(
      servers.some((item) => item.id === server.id)
        ? servers.map((item) => (item.id === server.id ? server : item))
        : [...servers, server]
    )
    editing = null
  }
  async function toggle(server: IdeLanguageServer, enabled: boolean): Promise<void> {
    if (busy) return
    busy = true
    error = ''
    try {
      await persist(servers.map((item) => (item.id === server.id ? { ...item, enabled } : item)))
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason)
    } finally {
      busy = false
    }
  }
  async function remove(): Promise<void> {
    if (!deleting || busy) return
    busy = true
    error = ''
    try {
      await persist(servers.filter((server) => server.id !== deleting?.id))
      deleting = null
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason)
    } finally {
      busy = false
    }
  }
  function add(): void {
    const selected = DEFAULT_IDE_LANGUAGE_SERVERS.find((server) => server.id === presetId)
    adding = false
    editing = selected
      ? structuredClone(
          $state.snapshot(servers.find((server) => server.id === selected.id) ?? selected)
        )
      : {
          id: crypto.randomUUID(),
          name: '',
          enabled: true,
          command: '',
          args: [],
          languages: [],
          env: {},
          rootMarkers: [],
          initializationOptions: {},
          settings: {}
        }
  }
  async function importServers(): Promise<void> {
    if (busy) return
    busy = true
    error = ''
    try {
      if (importText.length > 131072) throw new Error('Import JSON exceeds 128 KiB')
      const incoming = validateIdeLanguageServers(JSON.parse(importText))
      const ids = new Set(incoming.map((server) => server.id))
      await persist([...servers.filter((server) => !ids.has(server.id)), ...incoming])
      importing = false
      importText = ''
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason)
    } finally {
      busy = false
    }
  }
  async function check(server: IdeLanguageServer): Promise<void> {
    if (checking[server.id]) return
    checking[server.id] = true
    status[server.id] = ''
    try {
      const result = await invoke('projectFiles:ide', '', {
        owner: crypto.randomUUID(),
        action: 'check',
        path: '',
        serverId: server.id
      })
      const supported = Object.entries({
        definitions: result.capabilities?.definition,
        references: result.capabilities?.references,
        documentation: result.capabilities?.hover
      })
        .filter(([, enabled]) => enabled)
        .map(([name]) => name)
      status = {
        ...status,
        [server.id]: `Ready. ${supported.length ? supported.join(', ') : 'This server does not provide navigation'}.`
      }
    } catch (reason) {
      status = {
        ...status,
        [server.id]: String(reason).includes('ENOENT')
          ? `Executable not found: ${server.command}. Install this server or choose its executable with Edit.`
          : reason instanceof Error
            ? reason.message
            : String(reason)
      }
    } finally {
      checking[server.id] = false
    }
  }
  async function install(server: IdeLanguageServer): Promise<void> {
    if (busy || installing[server.id] || checking[server.id]) return
    installing[server.id] = true
    error = ''
    status = { ...status, [server.id]: 'Installing...' }
    try {
      await invoke('projectFiles:ide', '', {
        owner: crypto.randomUUID(),
        action: 'install',
        path: '',
        serverId: server.id
      })
      if (installations[server.id]?.source === 'missing' && !server.enabled)
        await persist(
          servers.map((item) => (item.id === server.id ? { ...item, enabled: true } : item))
        )
      else await refreshInstallations()
      await check(server)
    } catch (reason) {
      status = { ...status, [server.id]: ipcErrorMessage(reason, 'Installation failed') }
    } finally {
      installing[server.id] = false
    }
  }
  async function setupWithAgent(server?: IdeLanguageServer): Promise<void> {
    if (busy) return
    busy = true
    error = ''
    try {
      await openSetupConversation(
        workspaceState.activeProject ?? null,
        server ? `Set up ${server.name} for IDE Mode` : 'Set up a language server',
        server ? ideServerSetupRequest(server.name) : ideSetupRequest(),
        'cio-orchestrate'
      )
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason)
    } finally {
      busy = false
    }
  }
</script>

<div class="p-6 pb-24">
  <div class="mb-6 flex flex-wrap items-start justify-between gap-4">
    <div>
      <h1 class="flex items-center gap-2 text-xl font-bold tracking-tight">
        <CioCode size={18} class="text-muted" />IDE Mode
      </h1>
      <p class="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
        Language servers provide definitions, references, and documentation when IDE Mode is enabled
        in a file viewer.
      </p>
    </div>
  </div>
  <div class="mb-5 flex flex-wrap items-center justify-end gap-2">
    <button
      type="button"
      class={buttonClass}
      disabled={checkingUpdates || loadingInstallations}
      onclick={() => void refreshInstallations(true)}
    >
      <span class="flex items-center gap-2"
        >{#if checkingUpdates}<CioSpinner
            size={13}
            class="animate-spin"
            aria-hidden="true"
          />{/if}Check for updates</span
      >
    </button>
    <button
      type="button"
      class={buttonClass}
      onclick={() => {
        error = ''
        importing = true
      }}>Import</button
    >
    <button
      type="button"
      class={buttonClass}
      onclick={() => void copyText(JSON.stringify(servers, null, 2))}>Copy JSON</button
    >
    <button
      type="button"
      class="bg-primary px-2 py-1 text-xs text-on-primary disabled:opacity-40"
      disabled={busy || servers.length >= 32}
      onclick={() => {
        presetId =
          DEFAULT_IDE_LANGUAGE_SERVERS.find(
            (preset) => !servers.some((server) => server.id === preset.id)
          )?.id ?? 'custom'
        adding = true
      }}>Add server</button
    >
    <button type="button" class={buttonClass} disabled={busy} onclick={() => void setupWithAgent()}
      ><span class="flex items-center gap-2"><CioSparkles size={14} />Add server with agent</span
      ></button
    >
  </div>
  {#if error && !importing}<p class="mb-4 text-xs text-danger" role="alert">{error}</p>{/if}
  <div class="space-y-3">
    {#each servers as server (server.id)}
      {@const installation = installations[server.id]}
      {@const installed = installation && installation.source !== 'missing'}
      <SettingsEntry expanded={expanded[server.id] ?? false}>
        <div class="grid grid-cols-1 items-start gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div class="flex min-w-0 items-start gap-3">
            <CioCode size={20} class="mt-1 shrink-0 text-muted" />
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="text-sm font-semibold">{server.name}</h2>
                <SettingsStatusBadge
                  label={loadingInstallations
                    ? 'Checking'
                    : installed
                      ? installation.version
                        ? `Installed v${installation.version}`
                        : 'Installed'
                      : 'Not installed'}
                  classes={installed && server.enabled
                    ? 'border-success/30 bg-success/10 text-success'
                    : 'border-border bg-elevated text-muted'}
                  ><CioCircle size={12} /></SettingsStatusBadge
                >
                {#if installed && !server.enabled}<SettingsStatusBadge
                    label="Disabled"
                    classes="border-border bg-elevated text-muted"
                    ><CioCircle size={12} /></SettingsStatusBadge
                  >{/if}
                {#if hasUpdate(installation)}<SettingsStatusBadge
                    label="Update available"
                    classes="border-info/30 bg-info/10 text-info"
                    ><CioCircle size={12} /></SettingsStatusBadge
                  >{/if}
              </div>
            </div>
          </div>
          <div class="flex shrink-0 items-center justify-end gap-3">
            {#if installing[server.id]}<span class="flex items-center gap-2 text-xs text-muted"
                ><CioSpinner size={14} class="animate-spin" />Installing...</span
              >
            {:else if !loadingInstallations && !installed}
              <button
                type="button"
                class="border border-primary bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-40"
                disabled={busy}
                onclick={() =>
                  IDE_SERVER_PACKAGES[server.command]
                    ? void install(server)
                    : void setupWithAgent(server)}
                >{IDE_SERVER_PACKAGES[server.command] ? 'Install' : 'Set up'}</button
              >
            {:else if installed}
              {#if hasUpdate(installation)}<button
                  type="button"
                  class={buttonClass}
                  disabled={busy}
                  onclick={() => void install(server)}>Update</button
                >{/if}
              <Switch
                checked={server.enabled}
                disabled={busy}
                onchange={(enabled) => void toggle(server, enabled)}
                title={`Enable ${server.name}`}
                aria-label={`Enable ${server.name}`}
              />
            {/if}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                class="flex h-8 w-8 items-center justify-center border border-border bg-elevated text-muted hover:bg-overlay hover:text-foreground"
                title={`Actions for ${server.name}`}
                aria-label={`Actions for ${server.name}`}
                ><CioEllipsis size={15} /></DropdownMenu.Trigger
              >
              <DropdownMenu.Portal
                ><DropdownMenu.Content
                  side="bottom"
                  align="end"
                  sideOffset={5}
                  class="z-90 min-w-48 border border-border bg-surface p-1 text-foreground shadow-lg"
                >
                  {#if installed}<DropdownMenu.Item
                      disabled={checking[server.id] || installing[server.id]}
                      class="cursor-pointer px-3 py-2 text-xs outline-none data-[highlighted]:bg-elevated"
                      onSelect={() => void check(server)}>Check connection</DropdownMenu.Item
                    >{/if}
                  <DropdownMenu.Item
                    disabled={installing[server.id]}
                    class="cursor-pointer px-3 py-2 text-xs outline-none data-[highlighted]:bg-elevated"
                    onSelect={() => (editing = structuredClone($state.snapshot(server)))}
                    >Edit configuration</DropdownMenu.Item
                  >
                  <DropdownMenu.Item
                    class="cursor-pointer px-3 py-2 text-xs outline-none data-[highlighted]:bg-elevated"
                    onSelect={() => void setupWithAgent(server)}
                    >Set up with agent</DropdownMenu.Item
                  >
                  {#if installed && IDE_SERVER_PACKAGES[server.command]}<DropdownMenu.Item
                      disabled={installing[server.id]}
                      class="cursor-pointer px-3 py-2 text-xs outline-none data-[highlighted]:bg-elevated"
                      onSelect={() => void install(server)}>Reinstall</DropdownMenu.Item
                    >{/if}
                  <DropdownMenu.Separator class="my-1 h-px bg-border" />
                  <DropdownMenu.Item
                    disabled={installing[server.id]}
                    class="cursor-pointer px-3 py-2 text-xs text-danger outline-none data-[highlighted]:bg-danger/10"
                    onSelect={() => (deleting = server)}>Remove</DropdownMenu.Item
                  >
                </DropdownMenu.Content></DropdownMenu.Portal
              >
            </DropdownMenu.Root>
            <SettingsDisclosure
              expanded={expanded[server.id] ?? false}
              title={`${expanded[server.id] ? 'Hide' : 'Show'} ${server.name} details`}
              onclick={() => (expanded[server.id] = !expanded[server.id])}
            />
          </div>
        </div>
        {#if expanded[server.id]}
          <div class="mt-3 space-y-3 border-t border-border pt-3">
            <dl class="grid grid-cols-1 gap-4 text-xs sm:grid-cols-2">
              <div>
                <dt class="mb-1 font-medium text-muted">Executable</dt>
                <dd class="break-all font-mono">
                  {installation?.executable ?? server.command}
                  {server.args.join(' ')}
                </dd>
              </div>
              <div>
                <dt class="mb-1 font-medium text-muted">File types</dt>
                <dd>{server.languages.map((mapping) => mapping.extension).join(', ')}</dd>
              </div>
              {#if installation?.packageName}<div>
                  <dt class="mb-1 font-medium text-muted">Source</dt>
                  <dd>npm / {installation.packageName}</dd>
                </div>{/if}
              {#if installation?.latestVersion}<div>
                  <dt class="mb-1 font-medium text-muted">Latest version</dt>
                  <dd>{installation.latestVersion}</dd>
                </div>{/if}
            </dl>
            {#if installation?.source === 'external'}<div class="mt-4">
                <CardNotice>Updates are managed by your external installation.</CardNotice>
              </div>{/if}
            {#if installation?.updateError}<div class="mt-4">
                <CardNotice tone="warn">{installation.updateError}</CardNotice>
              </div>{/if}
          </div>
        {/if}
        {#if checking[server.id]}<div class="mt-3 flex items-center gap-2 text-xs text-muted">
            <CioSpinner size={13} class="animate-spin" />Checking connection...
          </div>{/if}
        {#if status[server.id] && !installing[server.id] && !checking[server.id]}
          <div class="mt-3">
            <CardNotice tone={status[server.id].startsWith('Ready.') ? 'default' : 'danger'}
              >{status[server.id].startsWith('Ready.')
                ? 'Connection verified.'
                : 'Server setup failed.'}</CardNotice
            >
            {#if !status[server.id].startsWith('Ready.')}<details
                class="border border-t-0 border-danger/30"
              >
                <summary
                  class="cursor-pointer bg-danger/5 px-3 py-2 text-xs font-medium text-danger hover:bg-danger/10"
                  >Error details</summary
                >
                <pre
                  class="max-h-40 overflow-auto whitespace-pre-wrap break-words border-t border-danger/30 bg-app px-3 py-2 font-mono text-xs text-muted">{status[
                    server.id
                  ]}</pre>
              </details>{/if}
          </div>
        {/if}
      </SettingsEntry>
    {:else}<p class="border border-border bg-surface p-4 text-sm text-muted">
        No language servers. Add a server to get started.
      </p>{/each}
  </div>
</div>
<Modal open={adding} title="Add language server" onClose={() => (adding = false)}>
  <label class="block text-xs text-muted"
    >Server
    <select
      aria-label="Language server preset"
      class="mt-2 w-full border border-border bg-app px-2 py-2 text-sm text-foreground"
      bind:value={presetId}
    >
      {#each DEFAULT_IDE_LANGUAGE_SERVERS.filter((preset) => !servers.some((server) => server.id === preset.id)) as preset (preset.id)}<option
          value={preset.id}>{preset.name}</option
        >{/each}
      <option value="custom">Custom server</option>
    </select>
  </label>
  {#snippet footer()}
    <button type="button" class={buttonClass} onclick={() => (adding = false)}>Cancel</button>
    <button
      type="button"
      data-modal-primary
      class="bg-primary px-3 py-2 text-sm text-on-primary"
      onclick={add}>Continue</button
    >
  {/snippet}
</Modal>
{#if editing}<IdeLanguageServerEditor
    server={editing}
    onClose={() => (editing = null)}
    onSave={saveServer}
  />{/if}
<ConfirmDialog
  open={deleting !== null}
  title={`Remove ${deleting?.name ?? 'language server'}?`}
  confirmLabel="Remove server"
  {busy}
  onCancel={() => (deleting = null)}
  onConfirm={remove}
  ><p class="text-sm text-muted">
    This removes its configuration. Installed language-server files are kept.
  </p>
  {#if error}<p class="mt-2 text-xs text-danger" role="alert">{error}</p>{/if}</ConfirmDialog
>
<Modal
  open={importing}
  title="Import language servers"
  size="lg"
  onClose={() => (importing = false)}
>
  <p class="mb-3 text-xs text-muted">
    Paste a JSON array. Matching server IDs are updated; other servers are kept.
  </p>
  <textarea
    aria-label="Language server JSON"
    maxlength={131072}
    class="h-64 w-full border border-border bg-app p-3 font-mono text-xs text-foreground outline-none focus:border-primary"
    bind:value={importText}></textarea>
  {#if error}<p class="mt-2 text-xs text-danger" role="alert">{error}</p>{/if}
  {#snippet footer()}<button
      type="button"
      class="px-3 py-2 text-sm text-muted"
      onclick={() => (importing = false)}>Cancel</button
    ><button
      type="button"
      data-modal-primary
      class="bg-primary px-3 py-2 text-sm text-on-primary disabled:opacity-40"
      disabled={busy}
      onclick={() => void importServers()}>Import servers</button
    >{/snippet}
</Modal>
