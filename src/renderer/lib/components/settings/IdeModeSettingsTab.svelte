<script lang="ts">
  import CioCode from '@pdslng/cio-icon/CioCode.svelte'
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
  let presetId = $state('typescript')
  let editing = $state<IdeLanguageServer | null>(null)
  let deleting = $state<IdeLanguageServer | null>(null)
  let importing = $state(false)
  let importText = $state('')
  let error = $state('')
  let busy = $state(false)
  let checking = $state<string | null>(null)
  let status = $state<Record<string, string>>({})
  const buttonClass =
    'border border-border bg-surface px-3 py-2 text-xs text-foreground hover:bg-elevated disabled:opacity-40'
  async function persist(next: IdeLanguageServer[]): Promise<void> {
    await updateConfig({ ideLanguageServers: validateIdeLanguageServers(next) })
    status = {}
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
    if (checking) return
    checking = server.id
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
      checking = null
    }
  }
  async function install(server: IdeLanguageServer): Promise<void> {
    if (busy || checking) return
    busy = true
    error = ''
    status = { ...status, [server.id]: 'Installing...' }
    try {
      await invoke('projectFiles:ide', '', {
        owner: crypto.randomUUID(),
        action: 'install',
        path: '',
        serverId: server.id
      })
      await check(server)
    } catch (reason) {
      status = { ...status, [server.id]: reason instanceof Error ? reason.message : String(reason) }
    } finally {
      busy = false
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
      <p class="mt-1 max-w-2xl text-sm text-muted">
        Install a language server once and use it across your projects. When you turn on IDE Mode in
        a file viewer, servers start in that project's workspace as you open files.
      </p>
    </div>
    <button type="button" class={buttonClass} disabled={busy} onclick={() => void setupWithAgent()}
      ><span class="flex items-center gap-2"><CioSparkles size={14} />Set up with agent</span
      ></button
    >
  </div>
  <p class="mb-4 text-xs text-muted">
    Install downloads the server into the app's tools folder and requires Bun on PATH. Use Edit for
    an existing executable. Agent setup opens a draft to review and send.
  </p>
  <div
    class="mb-5 flex flex-wrap items-end justify-between gap-3 border border-border bg-surface p-4"
  >
    <div class="flex flex-wrap items-end gap-2">
      <button
        type="button"
        class={buttonClass}
        onclick={() => {
          error = ''
          importing = true
        }}>Import JSON</button
      >
      <button
        type="button"
        class={buttonClass}
        onclick={() => void copyText(JSON.stringify(servers, null, 2))}>Copy JSON</button
      >
      <select
        aria-label="Language server preset"
        class="border border-border bg-app px-3 py-2 text-xs text-foreground"
        bind:value={presetId}
        >{#each DEFAULT_IDE_LANGUAGE_SERVERS as preset (preset.id)}<option value={preset.id}
            >{preset.name}</option
          >{/each}<option value="custom">Custom server</option></select
      >
      <button
        type="button"
        class="bg-primary px-3 py-2 text-xs font-medium text-on-primary disabled:opacity-40"
        disabled={busy ||
          (servers.length >= 32 && !servers.some((server) => server.id === presetId))}
        onclick={add}>Set up manually</button
      >
    </div>
  </div>
  {#if error && !importing}<p class="mb-4 text-xs text-danger" role="alert">{error}</p>{/if}
  <div class="space-y-2">
    {#each servers as server (server.id)}
      <section class="border border-border bg-surface p-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="min-w-0">
            <h2 class="text-sm font-semibold">{server.name}</h2>
            <p class="mt-1 truncate font-mono text-xs text-muted">
              {server.command}
              {server.args.join(' ')}
            </p>
            <p class="mt-1 text-xs text-muted">
              {server.languages.map((mapping) => mapping.extension).join(', ')}
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            {#if IDE_SERVER_PACKAGES[server.command]}
              <button
                type="button"
                class={buttonClass}
                disabled={busy || checking !== null}
                onclick={() => void install(server)}>Install</button
              >
            {/if}
            <Switch
              checked={server.enabled}
              disabled={busy}
              onchange={(enabled) => void toggle(server, enabled)}
              title={`Enable ${server.name}`}
              aria-label={`Enable ${server.name}`}
            /><button
              type="button"
              class={buttonClass}
              disabled={checking !== null || busy}
              onclick={() => void check(server)}
              >{checking === server.id ? 'Checking...' : 'Verify installation'}</button
            ><button
              type="button"
              class={buttonClass}
              disabled={busy}
              onclick={() => (editing = structuredClone($state.snapshot(server)))}>Edit</button
            ><button
              type="button"
              class={buttonClass}
              disabled={busy}
              onclick={() => (deleting = server)}>Remove</button
            >
          </div>
        </div>
        <p class="mt-3 text-xs text-muted" role="status">
          {status[server.id] ??
            (IDE_SERVER_PACKAGES[server.command]
              ? 'Install here, or verify an existing installation on PATH.'
              : 'Install this executable on PATH, or choose its path with Edit.')}
        </p>
        {#if !busy && checking === null && status[server.id] && !status[server.id].startsWith('Ready.')}
          <div class="mt-2 flex justify-end">
            <button
              type="button"
              class={buttonClass}
              disabled={busy}
              onclick={() => void setupWithAgent(server)}>Set up with agent</button
            >
          </div>
        {/if}
      </section>
    {:else}<p class="text-sm text-muted">
        No language servers configured. Choose a preset or add a custom server.
      </p>{/each}
  </div>
</div>
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
