<script lang="ts">
  import CioKey from '@pdslng/cio-icon/CioKey.svelte'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioUpload from '@pdslng/cio-icon/CioUpload.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { getProjectIcon, loadProjectIcons } from '$lib/project-icons'
  import { secretsPageState } from '$lib/stores/secrets-page-state.svelte'
  import { formatDateTimeCompact } from '$shared/date-time-format'
  import {
    DEFAULT_ENV_FILE_NAME,
    type ProjectEnvFile,
    type ProjectEnvImportPreview,
    type ProjectEnvLaunchPreview
  } from '$shared/project-env'
  import type { Project } from '$shared/types'
  import { SvelteMap } from 'svelte/reactivity'
  import { onMount } from 'svelte'
  import ProjectSelect, { type ProjectSelectOption } from '../../shared/ProjectSelect.svelte'
  import ConfirmDialog from '../../ui/ConfirmDialog.svelte'
  import EmptyState from '../../ui/EmptyState.svelte'
  import CreateEnvFileDialog from './CreateEnvFileDialog.svelte'
  import EnvImportModal from './EnvImportModal.svelte'
  import EnvKeyModal from './EnvKeyModal.svelte'

  /**
   * The env files of one project, and what a process started here would receive.
   *
   * The panel never shows a value: it edits names, shows where each one resolves
   * from, and reports what a launch would skip. Values are entered once and swapped
   * later; the vault is the only place they exist.
   */
  interface Props {
    /** Project the page was opened on, when an entry point supplied one. */
    projectId?: string
    /** Project-relative directory a process would start in, '' for the root. */
    directory?: string
  }

  let { projectId: initialProjectId, directory = '' }: Props = $props()

  let projects = $state<Project[]>([])
  /** Each project's real mark, so the picker never falls back to a folder glyph. */
  const projectIcons = new SvelteMap<string, string>()
  let projectId = $state('')
  let files = $state<ProjectEnvFile[]>([])
  let preview = $state<ProjectEnvLaunchPreview | null>(null)
  let loading = $state(true)
  let busy = $state(false)
  let error = $state('')

  let selectedGroup = $state('')
  let selectedFileName = $state(DEFAULT_ENV_FILE_NAME)

  let keyTarget = $state<{ existing: { name: string } | null } | null>(null)
  let importOpen = $state(false)
  let importPreview = $state<ProjectEnvImportPreview | null>(null)
  let deleteEntry = $state<string | null>(null)
  let deleteFileOpen = $state(false)
  let createFileOpen = $state(false)
  let newGroup = $state('')
  let newFileName = $state(DEFAULT_ENV_FILE_NAME)

  const selectedFile = $derived(
    files.find((file) => file.group === selectedGroup && file.fileName === selectedFileName) ?? null
  )
  const groups = $derived(
    [...new Set(files.map((file) => file.group))].sort((a, b) => a.localeCompare(b))
  )
  const localProjects = $derived(
    projects.filter((project) => project.source === 'local' && !project.hidden)
  )
  const projectOptions = $derived<ProjectSelectOption[]>(
    localProjects.map((project) => ({
      id: project.id,
      name: project.name,
      iconUrl: getProjectIcon(project, projectIcons.get(project.id)),
      ...(project.color ? { color: project.color } : {})
    }))
  )

  function report(cause: unknown, fallback: string): void {
    error = cause instanceof Error ? cause.message : fallback
  }

  async function loadProjects(): Promise<void> {
    try {
      projects = await invoke('project:list')
      if (!projectId) {
        const first = projects.find((project) => project.source === 'local' && !project.hidden)
        projectId = first?.id ?? ''
      }
      const local = projects.filter((project) => project.source === 'local' && !project.hidden)
      const stored = await loadProjectIcons(local)
      for (const project of local) {
        const icon = getProjectIcon(project, stored.get(project.id))
        if (icon) projectIcons.set(project.id, icon)
      }
    } catch (cause) {
      report(cause, 'Could not read the projects')
    }
  }

  async function load(): Promise<void> {
    if (!projectId) {
      files = []
      preview = null
      loading = false
      return
    }
    loading = true
    try {
      files = await invoke('secrets:envList', projectId)
      preview = await invoke('secrets:envPreview', { projectId, directory })
      const current = files.find(
        (file) => file.group === selectedGroup && file.fileName === selectedFileName
      )
      if (!current && files.length > 0) {
        const first = files[0]
        if (first) {
          selectedGroup = first.group
          selectedFileName = first.fileName
        }
      }
    } catch (cause) {
      report(cause, 'Could not read this project’s env files')
    } finally {
      loading = false
    }
  }

  async function selectProject(nextId: string): Promise<void> {
    projectId = nextId
    selectedGroup = ''
    selectedFileName = DEFAULT_ENV_FILE_NAME
    await load()
  }

  async function saveValue(input: { name: string; value: string }): Promise<void> {
    busy = true
    error = ''
    try {
      files = await invoke('secrets:envSetValue', {
        projectId,
        group: selectedGroup,
        fileName: selectedFileName,
        name: input.name,
        value: input.value
      })
      keyTarget = null
      preview = await invoke('secrets:envPreview', { projectId, directory })
    } catch (cause) {
      report(cause, 'Could not store this value')
    } finally {
      busy = false
    }
  }

  async function removeEntry(): Promise<void> {
    const name = deleteEntry
    if (!name) return
    busy = true
    error = ''
    try {
      files = await invoke('secrets:envRemoveEntry', {
        projectId,
        group: selectedGroup,
        fileName: selectedFileName,
        name
      })
      deleteEntry = null
      preview = await invoke('secrets:envPreview', { projectId, directory })
    } catch (cause) {
      report(cause, 'Could not remove this key')
    } finally {
      busy = false
    }
  }

  async function createFile(): Promise<void> {
    busy = true
    error = ''
    try {
      const group = newGroup.trim().replace(/^\/+|\/+$/gu, '')
      files = await invoke('secrets:envCreateFile', {
        projectId,
        group,
        fileName: newFileName.trim()
      })
      selectedGroup = group
      selectedFileName = newFileName.trim()
      createFileOpen = false
      newGroup = ''
      newFileName = DEFAULT_ENV_FILE_NAME
    } catch (cause) {
      report(cause, 'Could not create this env file')
    } finally {
      busy = false
    }
  }

  async function deleteFile(): Promise<void> {
    busy = true
    error = ''
    try {
      files = await invoke('secrets:envDeleteFile', {
        projectId,
        group: selectedGroup,
        fileName: selectedFileName
      })
      deleteFileOpen = false
      selectedGroup = ''
      selectedFileName = DEFAULT_ENV_FILE_NAME
      preview = await invoke('secrets:envPreview', { projectId, directory })
    } catch (cause) {
      report(cause, 'Could not delete this env file')
    } finally {
      busy = false
    }
  }

  async function previewImport(path: string): Promise<void> {
    busy = true
    error = ''
    try {
      const result = await invoke('secrets:envImport', {
        projectId,
        group: selectedGroup,
        fileName: selectedFileName,
        path,
        apply: false
      })
      importPreview = result.preview
    } catch (cause) {
      importPreview = null
      report(cause, 'Could not read that file')
    } finally {
      busy = false
    }
  }

  async function applyImport(path: string): Promise<void> {
    busy = true
    error = ''
    try {
      const result = await invoke('secrets:envImport', {
        projectId,
        group: selectedGroup,
        fileName: selectedFileName,
        path,
        apply: true
      })
      files = result.files
      importOpen = false
      importPreview = null
      preview = await invoke('secrets:envPreview', { projectId, directory })
    } catch (cause) {
      report(cause, 'Could not import that file')
    } finally {
      busy = false
    }
  }

  onMount(() => {
    // An entry point's project wins over the first project in the list, and is
    // read here rather than captured at construction.
    if (initialProjectId) projectId = initialProjectId
    void loadProjects().then(load)
  })

  // An entry point that names a different project re-targets the panel instead of
  // leaving it on whatever was selected before.
  $effect(() => {
    const target = secretsPageState.target
    if (!target?.projectId || target.projectId === projectId) return
    void selectProject(target.projectId)
  })
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div class="w-64 shrink-0">
      <p class="text-xs font-medium text-muted">Project</p>
      <ProjectSelect
        projects={projectOptions}
        value={projectId || null}
        onValueChange={(next) => void selectProject(next)}
        ariaLabel="Select the project whose env files to edit"
        placeholder="Select a project"
        searchPlaceholder="Search projects…"
        emptyMessage="No local projects"
        class="mt-1"
      />
    </div>
    <div class="flex items-center gap-2">
      <button
        type="button"
        class="flex h-8 items-center gap-1.5 border px-2.5 text-xs hover:bg-elevated disabled:opacity-40"
        disabled={!projectId || busy}
        title="Create an env file for this project"
        onclick={() => {
          newGroup = selectedGroup
          newFileName = DEFAULT_ENV_FILE_NAME
          createFileOpen = true
        }}
      >
        <CioPlus size={13} /> Env file
      </button>
      <button
        type="button"
        class="flex h-8 items-center gap-1.5 border px-2.5 text-xs hover:bg-elevated disabled:opacity-40"
        disabled={!selectedFile || busy}
        title="Import a plaintext env file into the vault"
        onclick={() => {
          importPreview = null
          importOpen = true
        }}
      >
        <CioUpload size={13} /> Import
      </button>
    </div>
  </div>

  {#if error}
    <p class="bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</p>
  {/if}

  {#if loading}
    <div class="flex items-center gap-2 border bg-surface px-4 py-3 text-xs text-muted">
      <CioSpinner size={14} class="animate-spin" /> Reading env files...
    </div>
  {:else if !projectId}
    <div class="border bg-surface">
      <EmptyState
        icon={CioKey}
        title="No project to attach an env file to"
        description="Add a local project first. Its env files live here, and their values live in the vault instead of the repository."
      />
    </div>
  {:else if files.length === 0}
    <div class="border bg-surface">
      <EmptyState
        icon={CioKey}
        title="No env file yet"
        description="Create one for this project, or import an existing .env so its values move into the vault and the file keeps only references."
      />
    </div>
  {:else}
    <div class="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <section class="border bg-surface" aria-label="Env files">
        <h2
          class="border-b px-3 py-2 text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase"
        >
          Files
        </h2>
        <div class="divide-y">
          {#each groups as group (group)}
            <div class="px-3 py-2">
              <p
                class="truncate font-mono text-[0.6875rem] text-muted"
                title={group || 'project root'}
              >
                {group || '.'}
              </p>
              <div class="mt-1 space-y-0.5">
                {#each files.filter((file) => file.group === group) as file (file.fileName)}
                  {@const active =
                    file.group === selectedGroup && file.fileName === selectedFileName}
                  <button
                    type="button"
                    class="flex w-full items-center justify-between gap-2 px-1.5 py-1 text-left text-xs transition-colors {active
                      ? 'bg-elevated text-foreground'
                      : 'text-muted hover:bg-elevated hover:text-foreground'}"
                    aria-current={active ? 'true' : undefined}
                    title="Edit {group || 'project root'}/{file.fileName}"
                    onclick={() => {
                      selectedGroup = file.group
                      selectedFileName = file.fileName
                    }}
                  >
                    <span class="truncate font-mono">{file.fileName}</span>
                    <span class="tabular-nums text-dimmed">{file.entries.length}</span>
                  </button>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      </section>

      <div class="space-y-4">
        {#if selectedFile}
          <section class="border bg-surface" aria-label="Env keys">
            <div class="flex items-center justify-between gap-2 border-b px-4 py-2">
              <p class="font-mono text-xs text-foreground">
                {selectedFile.group || '.'}/{selectedFile.fileName}
              </p>
              <div class="flex items-center gap-1">
                <button
                  type="button"
                  class="flex h-7 items-center gap-1.5 bg-primary px-2 text-xs font-medium text-on-primary disabled:opacity-40"
                  disabled={busy}
                  title="Add a key to this env file"
                  onclick={() => (keyTarget = { existing: null })}
                >
                  <CioPlus size={12} /> Key
                </button>
                <button
                  type="button"
                  class="flex h-7 items-center border px-2 text-xs text-danger hover:bg-danger/10"
                  disabled={busy}
                  title="Delete this env file and its values"
                  onclick={() => (deleteFileOpen = true)}
                >
                  Delete file
                </button>
              </div>
            </div>

            {#if selectedFile.entries.length === 0}
              <div class="px-4 py-6 text-xs text-muted">
                No keys yet. Add one, or import a plaintext env file to move its values here.
              </div>
            {:else}
              <div class="divide-y">
                {#each selectedFile.entries as entry (entry.name)}
                  <div class="flex items-start gap-3 px-4 py-2.5">
                    <div class="min-w-0 flex-1">
                      <p class="truncate font-mono text-xs text-foreground" title={entry.name}>
                        {entry.name}
                      </p>
                      <p
                        class="mt-0.5 flex flex-wrap items-center gap-x-3 text-[0.6875rem] text-dimmed"
                      >
                        <span class="tabular-nums"
                          >Updated {formatDateTimeCompact(entry.updatedAt)}</span
                        >
                        {#if entry.missing}
                          <span class="text-danger">Value is gone, set it again</span>
                        {/if}
                      </p>
                    </div>
                    <div class="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        class="h-7 border px-2 text-xs text-muted hover:bg-elevated hover:text-foreground"
                        disabled={busy}
                        title="Replace the value of {entry.name}"
                        onclick={() => (keyTarget = { existing: { name: entry.name } })}
                      >
                        Replace
                      </button>
                      <button
                        type="button"
                        class="h-7 border px-2 text-xs text-danger hover:bg-danger/10"
                        disabled={busy}
                        title="Delete {entry.name} and forget its value"
                        onclick={() => (deleteEntry = entry.name)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
            {#if selectedFile.importedFrom}
              <p class="border-t px-4 py-2 text-[0.6875rem] text-dimmed">
                Imported from <span class="font-mono">{selectedFile.importedFrom}</span>; the
                original is kept beside it as
                <span class="font-mono">.cio-backup</span>.
              </p>
            {/if}
          </section>
        {/if}

        {#if preview}
          <section class="border bg-surface" aria-label="What a launch receives">
            <h2
              class="border-b px-4 py-2 text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase"
            >
              What a process started in {directory ? directory : 'the project root'} receives
            </h2>
            {#if preview.entries.length === 0 && preview.skipped.length === 0}
              <p class="px-4 py-3 text-xs text-muted">Nothing yet.</p>
            {:else}
              <div class="divide-y">
                {#each preview.entries as entry (entry.name)}
                  <div class="flex items-center justify-between gap-3 px-4 py-1.5">
                    <span
                      class="truncate font-mono text-[0.6875rem] text-foreground"
                      title={entry.name}
                    >
                      {entry.name}
                    </span>
                    <span class="shrink-0 text-[0.6875rem] text-dimmed">
                      {entry.scope === 'thread'
                        ? 'this thread'
                        : `${entry.group || '.'}/${entry.fileName}`}
                    </span>
                  </div>
                {/each}
                {#each preview.skipped as entry (entry.name)}
                  <div class="flex items-center justify-between gap-3 px-4 py-1.5">
                    <span class="truncate font-mono text-[0.6875rem] text-muted" title={entry.name}>
                      {entry.name}
                    </span>
                    <span class="shrink-0 text-[0.6875rem] text-danger">{entry.reason}</span>
                  </div>
                {/each}
              </div>
            {/if}
          </section>
        {/if}
      </div>
    </div>
  {/if}
</div>

{#if keyTarget}
  <EnvKeyModal
    existing={keyTarget.existing}
    group={selectedGroup}
    fileName={selectedFileName}
    {busy}
    {error}
    onSubmit={saveValue}
    onClose={() => {
      if (!busy) keyTarget = null
    }}
  />
{/if}

{#if importOpen}
  <EnvImportModal
    group={selectedGroup}
    fileName={selectedFileName}
    {busy}
    {error}
    preview={importPreview}
    onPreview={previewImport}
    onApply={applyImport}
    onClose={() => {
      if (busy) return
      importOpen = false
      importPreview = null
    }}
  />
{/if}

{#if createFileOpen}
  <CreateEnvFileDialog
    bind:group={newGroup}
    bind:name={newFileName}
    {busy}
    onCreate={createFile}
    onClose={() => (createFileOpen = false)}
  />
{/if}

<ConfirmDialog
  open={deleteFileOpen}
  title="Delete this env file?"
  confirmLabel="Delete env file"
  note="Its keys and the values behind them are removed from the vault."
  {busy}
  onCancel={() => (deleteFileOpen = false)}
  onConfirm={deleteFile}
>
  <p>
    <span class="font-mono text-foreground">{selectedGroup || '.'}/{selectedFileName}</span>
    is deleted. A copy in the repository is not touched.
  </p>
</ConfirmDialog>

<ConfirmDialog
  open={deleteEntry !== null}
  title="Delete this key?"
  confirmLabel="Delete key"
  note="The value is removed from the vault and cannot be recovered."
  {busy}
  onCancel={() => (deleteEntry = null)}
  onConfirm={removeEntry}
>
  <p>
    <span class="font-mono text-foreground">{deleteEntry ?? ''}</span> is removed from this file.
  </p>
</ConfirmDialog>
