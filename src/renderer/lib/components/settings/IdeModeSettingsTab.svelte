<script lang="ts">
  import { onMount } from 'svelte'
  import CioServer from '@pdslng/cio-icon/CioServer.svelte'
  import CioSparkles from '@pdslng/cio-icon/CioSparkles.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import IdeLanguageServerEditor from './IdeLanguageServerEditor.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { copyText } from '$lib/copy-text'
  import { openSetupConversation } from '$lib/utility-setup-thread'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import type { AppConfig, AppConfigPatch, Project } from '$shared/types'
  import {
    DEFAULT_IDE_LANGUAGE_SERVERS,
    validateIdeLanguageServers,
    type IdeLanguageServer
  } from '$shared/ide-language-servers'
  interface Props {
    config: AppConfig
    updateConfig: (patch: AppConfigPatch) => Promise<void>
  }
  let { config, updateConfig }: Props = $props()
  let servers = $derived(config.ideLanguageServers ?? DEFAULT_IDE_LANGUAGE_SERVERS)
  let projects = $state<Project[]>([])
  let projectId = $state('')
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
  onMount(() => {
    void invoke('project:list')
      .then((result) => {
        projects = result.filter(
          (project) => project.source === 'local' && !project.hidden && project.path
        )
        projectId =
          projects.find((project) => project.id === workspaceState.activeProject?.id)?.id ??
          projects[0]?.id ??
          ''
      })
      .catch((reason) => {
        error = reason instanceof Error ? reason.message : String(reason)
      })
  })
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
    if (!projectId || checking) return
    checking = server.id
    try {
      const result = await invoke(
        'projectFiles:ide',
        projectId,
        {
          owner: crypto.randomUUID(),
          action: 'check',
          path: '',
          serverId: server.id
        },
        workspaceState.activeScopeBucketIdFor(projectId)
      )
      const supported = Object.entries(result.capabilities ?? {})
        .filter(([, enabled]) => enabled)
        .map(([name]) => name)
      status = {
        ...status,
        [server.id]: `Connected. ${supported.length ? supported.join(', ') : 'No navigation capabilities advertised'}.`
      }
    } catch (reason) {
      status = { ...status, [server.id]: reason instanceof Error ? reason.message : String(reason) }
    } finally {
      checking = null
    }
  }
  async function setupWithAgent(): Promise<void> {
    if (busy) return
    busy = true
    error = ''
    try {
      const project = projects.find((project) => project.id === projectId) ?? null
      await openSetupConversation(
        project,
        'Set up IDE Mode language servers',
        `Help me set up standard stdio language servers for IDE Mode. Ask which languages and existing editor configuration I want to use. Inspect this project's languages and existing server installations. Help install missing language servers using the appropriate tools. Return a JSON array I can import into Settings > IDE Mode. Each server has id, name, enabled, command (executable only), args (string array), languages ([{extension:'.go',languageId:'go'}]), env (string record supporting inherited variable references), rootMarkers (file/directory names), initializationOptions (object), and settings (object). Keep credentials in environment variables. Use one enabled server per extension. Return only the new or modified entries; preserve other server configurations. Do not turn on IDE Mode globally or modify project source to remember configuration. Existing server identities and languages:\n${JSON.stringify(
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
        <CioServer size={18} class="text-muted" />IDE Mode
      </h1>
      <p class="mt-1 max-w-2xl text-sm text-muted">
        Set up language servers for project editing. Turn IDE Mode on separately in each project
        tree's file viewer menu.
      </p>
    </div>
    <button type="button" class={buttonClass} disabled={busy} onclick={() => void setupWithAgent()}
      ><span class="flex items-center gap-2"><CioSparkles size={14} />Set up with agent</span
      ></button
    >
  </div>
  <p class="mb-4 text-xs text-muted">
    Agent setup opens a draft to review and send. Import the returned server JSON here.
  </p>
  <div
    class="mb-5 flex flex-wrap items-end justify-between gap-3 border border-border bg-surface p-4"
  >
    <label class="text-xs text-muted"
      >Check and set up in project<select
        aria-label="Language server project"
        class="mt-1 block max-w-xs border border-border bg-app px-3 py-2 text-sm text-foreground"
        bind:value={projectId}
        ><option value="">Choose a project</option>{#each projects as project (project.id)}<option
            value={project.id}>{project.name}</option
          >{/each}</select
      ></label
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
        disabled={busy || servers.length >= 32}
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
            <Switch
              checked={server.enabled}
              disabled={busy}
              onchange={(enabled) => void toggle(server, enabled)}
              title={`Enable ${server.name}`}
              aria-label={`Enable ${server.name}`}
            /><button
              type="button"
              class={buttonClass}
              disabled={!projectId || checking !== null || busy}
              onclick={() => void check(server)}
              >{checking === server.id ? 'Checking...' : 'Check setup'}</button
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
        {#if status[server.id]}<p class="mt-3 text-xs text-muted" role="status">
            {status[server.id]}
          </p>{/if}
      </section>
    {:else}<p class="text-sm text-muted">
        No language servers configured. Choose a preset or add a custom server.
      </p>{/each}
  </div>
  <p class="mt-5 text-xs text-muted">
    Servers must speak LSP over stdio and be installed locally or on PATH. The nearest root marker
    inside the project selects the workspace. Saving changes stops sessions that use the old
    configuration.
  </p>
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
