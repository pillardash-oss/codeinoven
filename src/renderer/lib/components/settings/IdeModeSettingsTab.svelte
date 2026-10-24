<script lang="ts">
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
    void refreshInstallations()
  })
  function hasUpdate(item: IdeInstallation | undefined): boolean {
    if (!item?.version || !item.latestVersion) return false
    return item.latestVersion.localeCompare(item.version, undefined, { numeric: true }) > 0
  }
  let adding = $state(false)
  let presetId = $state('typescript')
  let editing = $state<IdeLanguageServer | null>(null)
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
      await refreshInstallations()
      await check(server)
    } catch (reason) {
      status = { ...status, [server.id]: reason instanceof Error ? reason.message : String(reason) }
    } finally {
      installing[server.id] = false
    }
  }
  async function setupWithAgent(server?: IdeLanguageServer): Promise<void> {
    if (busy) return
    busy = true
    error = ''
    try {
      const project = workspaceState.activeProject ?? null
      await openSetupConversation(
        project,
        server ? `Set up ${server.name} for IDE Mode` : 'Set up IDE Mode language servers',
        `Help me set up standard stdio language servers for IDE Mode. ${server ? `Set up ${server.name}, executable ${server.command}, for ${server.languages.map((mapping) => mapping.languageId).join(', ')}. Latest setup result: ${status[server.id] ?? 'Not checked'}.` : 'Inspect the project languages and ask which existing editor configuration I want to reuse.'} Inspect this project's languages and existing server installations. Help install missing language servers using the appropriate tools. Return a JSON array I can import into Settings > IDE Mode. Each server has id, name, enabled, command (executable only), args (string array), languages ([{extension:'.go',languageId:'go'}]), env (string record supporting inherited variable references), rootMarkers (file/directory names), initializationOptions (object), and settings (object). Keep credentials in environment variables. Use one enabled server per extension. Return only the new or modified entries; preserve other server configurations. Do not turn on IDE Mode globally or modify project source to remember configuration. Existing server identities and languages:\n${JSON.stringify(
          servers.map((server) => ({
            id: server.id,
            name: server.name,
            languages: server.languages.slice(0, 12).map((mapping) => mapping.languageId)
          })),
          null,
          2
        )}`
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
    </div>
    <button type="button" class={buttonClass} disabled={busy} onclick={() => void setupWithAgent()}
      ><span class="flex items-center gap-2"><CioSparkles size={14} />Set up with agent</span
      ></button
    >
  </div>
  <div class="mb-3 flex flex-wrap items-center justify-end gap-2">
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
  </div>
  {#if error && !importing}<p class="mb-4 text-xs text-danger" role="alert">{error}</p>{/if}
  <div class="divide-y divide-border border border-border">
    {#each servers as server (server.id)}
      {@const installation = installations[server.id]}
      <section class="bg-surface px-3 py-2">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="min-w-0">
            <h2 class="text-sm font-semibold">{server.name}</h2>
            <p class="text-xs text-muted">
              {loadingInstallations
                ? 'Checking...'
                : installation?.source === 'managed'
                  ? installation.version
                    ? `Installed v${installation.version}`
                    : 'Installed'
                  : installation?.source === 'external'
                    ? 'External'
                    : 'Not installed'}
              {#if hasUpdate(installation)}<span class="ml-2 text-primary">Update available</span
                >{/if}
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            {#if IDE_SERVER_PACKAGES[server.command]}
              <button
                type="button"
                class={buttonClass}
                disabled={loadingInstallations ||
                  busy ||
                  installing[server.id] ||
                  checking[server.id]}
                onclick={() => void install(server)}
                ><span class="flex items-center gap-2"
                  >{#if installing[server.id]}<CioSpinner
                      size={13}
                      class="animate-spin"
                      aria-hidden="true"
                    />Installing...{:else if loadingInstallations}Checking...{:else if installation?.source === 'managed'}{hasUpdate(
                      installation
                    )
                      ? 'Update'
                      : 'Reinstall'}{:else if installation?.source === 'external'}Install{:else}Install{/if}</span
                ></button
              >
            {/if}
            <Switch
              checked={server.enabled}
              disabled={busy || installing[server.id]}
              onchange={(enabled) => void toggle(server, enabled)}
              title={`Enable ${server.name}`}
              aria-label={`Enable ${server.name}`}
            /><button
              type="button"
              class={buttonClass}
              disabled={checking[server.id] || installing[server.id] || busy}
              onclick={() => void check(server)}
              ><span class="flex items-center gap-2"
                >{#if checking[server.id]}<CioSpinner
                    size={13}
                    class="animate-spin"
                    aria-hidden="true"
                  />Checking...{:else}Check{/if}</span
              ></button
            ><button
              type="button"
              class={buttonClass}
              disabled={busy || installing[server.id]}
              onclick={() => (editing = structuredClone($state.snapshot(server)))}>Edit</button
            ><button
              type="button"
              class={buttonClass}
              disabled={busy || installing[server.id]}
              onclick={() => (deleting = server)}>Remove</button
            >
          </div>
        </div>
        <details class="mt-1 text-xs text-muted">
          <summary class="w-fit cursor-pointer">Details</summary>
          <div class="space-y-1 py-2">
            <p class="break-all font-mono">{server.command} {server.args.join(' ')}</p>
            <p>{server.languages.map((mapping) => mapping.extension).join(', ')}</p>
            {#if installation?.executable}<p class="break-all font-mono">
                {installation.executable}
              </p>{/if}
            {#if installation?.packageName}<p>npm: {installation.packageName}</p>{/if}
            {#if installation?.latestVersion}<p>Latest: {installation.latestVersion}</p>{/if}
            {#if installation?.updateError}<p>{installation.updateError}</p>{/if}
            {#if status[server.id]}<p
                class="max-h-32 overflow-auto whitespace-pre-wrap break-all"
                role="status"
              >
                {status[server.id]}
              </p>{/if}
          </div>
        </details>
        {#if status[server.id] && !installing[server.id] && !checking[server.id]}
          <p class="mt-1 text-xs text-muted" role="status">
            {status[server.id].startsWith('Ready.') ? 'Ready' : 'Check failed. See details.'}
          </p>
        {/if}
      </section>
    {:else}<p class="text-sm text-muted">
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
