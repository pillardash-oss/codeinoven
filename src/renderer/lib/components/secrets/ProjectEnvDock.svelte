<script lang="ts">
  import CioKey from '@pdslng/cio-icon/CioKey.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { projectEnvDock } from '$lib/stores/project-env-dock.svelte'
  import { secretsPageState } from '$lib/stores/secrets-page-state.svelte'
  import { APP_SLUG } from '$shared/brand'
  import {
    PROJECT_ENV_MODES,
    projectEnvModeFileName,
    type ProjectEnvFile,
    type ProjectEnvMode
  } from '$shared/project-env'
  import { onMount } from 'svelte'
  import DockableModal from '../ui/DockableModal.svelte'
  import DockRow from '../ui/DockRow.svelte'

  /**
   * The project's env secrets, as a floating editor.
   *
   * A project row's key button and the file explorer's `Secrets` action both open
   * this panel instead of leaving the work in front of the user. The body is the
   * file itself, typed the way a `.env` is typed: a line with a value stores that
   * value, a line without one keeps what is already stored, and a name whose line
   * is gone is removed. Values never come back from the main process, so a stored
   * key appears as its name with an empty value.
   */
  const storageKey = `${APP_SLUG}.projectEnvDock.v1`

  const modes = PROJECT_ENV_MODES.filter((mode) => mode !== 'test')

  let files = $state<ProjectEnvFile[]>([])
  let mode = $state<ProjectEnvMode>('default')
  let body = $state('')
  let loading = $state(true)
  let saving = $state(false)
  let error = $state('')
  /** What the last save did, in the user's words. */
  let outcome = $state('')
  let dirty = $state(false)

  const group = $derived(projectEnvDock.group)
  const groupLabel = $derived(group || '.')
  const current = $derived(files.find((file) => file.group === group && file.mode === mode) ?? null)
  const storedCount = $derived(current?.entries.length ?? 0)

  /**
   * The edited file, rendered as a `.env` body: one name per line, value left
   * blank because the vault never hands a value back to this surface.
   */
  function bodyFor(file: ProjectEnvFile | null): string {
    if (!file) return ''
    return file.entries.map((entry) => `${entry.name}=`).join('\n')
  }

  async function load(): Promise<void> {
    const projectId = projectEnvDock.projectId
    if (!projectId) return
    loading = true
    error = ''
    try {
      files = await invoke('secrets:envList', projectId)
      body = bodyFor(files.find((file) => file.group === group && file.mode === mode) ?? null)
      dirty = false
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not read this project’s env files'
    } finally {
      loading = false
    }
  }

  async function save(): Promise<void> {
    const projectId = projectEnvDock.projectId
    if (!projectId) return
    saving = true
    error = ''
    outcome = ''
    try {
      const result = await invoke('secrets:envApplyText', { projectId, group, mode, text: body })
      files = result.files
      body = bodyFor(
        result.files.find((file) => file.group === group && file.mode === mode) ?? null
      )
      dirty = false
      const parts: string[] = []
      if (result.stored.length > 0) {
        parts.push(
          `${result.stored.length} ${result.stored.length === 1 ? 'value' : 'values'} stored`
        )
      }
      if (result.kept.length > 0) parts.push(`${result.kept.length} kept as they were`)
      if (result.removed.length > 0) parts.push(`${result.removed.length} removed`)
      if (result.skipped.length > 0) {
        parts.push(
          `${result.skipped.length} ${result.skipped.length === 1 ? 'line' : 'lines'} ignored`
        )
      }
      outcome = parts.length > 0 ? `${parts.join(', ')}.` : 'Nothing changed.'
      const firstSkip = result.skipped[0]
      if (firstSkip) error = `Line ${firstSkip.line}: ${firstSkip.reason}`
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save this env file'
    } finally {
      saving = false
    }
  }

  async function selectMode(next: ProjectEnvMode): Promise<void> {
    if (next === mode || dirty) return
    mode = next
    await load()
  }

  // The panel is mounted per project (the root keys it), so one read per mount is
  // the whole story; switching modes reads again through selectMode.
  onMount(() => {
    void load()
  })
</script>

<DockableModal
  open={true}
  title="Env secrets"
  minimized={projectEnvDock.minimized}
  closable
  onMinimize={() => projectEnvDock.minimize()}
  onClose={() => projectEnvDock.close()}
  {storageKey}
  dragLabel="Drag to move the env secrets panel"
  defaultHeight={480}
  flushBody
  onPrimaryAction={() => {
    if (saving || loading) return false
    void save()
    return true
  }}
>
  {#snippet headerPrefix()}
    <span class="flex min-w-0 items-center gap-2 pr-1">
      <span
        class="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden border bg-raised text-dimmed"
        style:border-color={projectEnvDock.color ?? undefined}
        aria-hidden="true"
      >
        {#if projectEnvDock.iconUrl}
          <img src={projectEnvDock.iconUrl} alt="" class="h-4 w-4 object-contain" />
        {:else}
          <CioKey size={13} />
        {/if}
      </span>
      <span
        class="min-w-0 truncate text-xs font-semibold text-foreground"
        title={projectEnvDock.projectName}
      >
        {projectEnvDock.projectName}
      </span>
      <span class="shrink-0 text-xs text-dimmed">{groupLabel}/{projectEnvModeFileName(mode)}</span>
    </span>
  {/snippet}

  {#snippet headerActions()}
    <button
      type="button"
      class="flex h-7 items-center border px-2 text-[0.6875rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
      title="Open the full env editor, with import and every run mode"
      onclick={() => {
        const projectId = projectEnvDock.projectId
        if (projectId) secretsPageState.open({ projectId, directory: group })
        projectEnvDock.close()
      }}
    >
      All files
    </button>
  {/snippet}

  {#snippet dock()}
    <DockRow {storageKey} label="Move docked env secrets">
      <button
        type="button"
        class="flex items-center gap-2 border bg-surface px-2.5 py-1.5 text-left shadow-xl transition-colors hover:bg-elevated"
        title="Show env secrets for {projectEnvDock.projectName}"
        aria-label="Show env secrets for {projectEnvDock.projectName}"
        onclick={() => projectEnvDock.expand()}
      >
        <CioKey size={13} class="shrink-0 text-dimmed" />
        <span class="text-[0.625rem] font-medium text-foreground">Env secrets</span>
        <span class="max-w-40 truncate text-[0.5625rem] text-muted"
          >{projectEnvDock.projectName}</span
        >
      </button>
    </DockRow>
  {/snippet}

  <div class="flex h-full min-h-0 flex-col">
    <div class="flex items-center gap-1 border-b px-2 py-1.5">
      {#each modes as candidate (candidate)}
        <button
          type="button"
          class="px-2 py-1 text-[0.6875rem] font-medium transition-colors {mode === candidate
            ? 'bg-elevated text-foreground'
            : 'text-muted hover:bg-elevated hover:text-foreground'}"
          aria-pressed={mode === candidate}
          disabled={dirty && mode !== candidate}
          title={dirty && mode !== candidate
            ? 'Save this file before switching run mode'
            : `Edit ${groupLabel}/${projectEnvModeFileName(candidate)}`}
          onclick={() => void selectMode(candidate)}
        >
          {projectEnvModeFileName(candidate)}
        </button>
      {/each}
      <span class="ml-auto shrink-0 text-[0.6875rem] tabular-nums text-dimmed">
        {storedCount}
        {storedCount === 1 ? 'key' : 'keys'} stored
      </span>
    </div>

    <div class="min-h-0 flex-1">
      {#if loading}
        <div class="flex items-center gap-2 px-3 py-3 text-xs text-muted">
          <CioSpinner size={13} class="animate-spin" /> Reading {groupLabel}/{projectEnvModeFileName(
            mode
          )}...
        </div>
      {:else}
        <textarea
          class="h-full w-full resize-none bg-app p-3 font-mono text-xs leading-relaxed text-foreground outline-none placeholder:text-dimmed"
          spellcheck="false"
          autocomplete="off"
          aria-label="Env file body for {projectEnvDock.projectName}"
          placeholder="# One KEY=value per line.&#10;DATABASE_URL="
          value={body}
          oninput={(event) => {
            body = event.currentTarget.value
            dirty = true
            outcome = ''
          }}></textarea>
      {/if}
    </div>

    {#if error}
      <p class="border-t bg-danger/10 px-3 py-1.5 text-[0.6875rem] text-danger" role="alert">
        {error}
      </p>
    {:else if outcome}
      <p class="border-t px-3 py-1.5 text-[0.6875rem] text-muted" role="status">{outcome}</p>
    {:else}
      <p class="border-t px-3 py-1.5 text-[0.6875rem] text-muted">
        A value stores into the vault; a line left empty keeps what is already stored; deleting a
        line removes its key.
      </p>
    {/if}
  </div>

  {#snippet footer()}
    <button type="button" class="border px-3 py-1.5 text-sm" onclick={() => projectEnvDock.close()}>
      Close
    </button>
    <button
      type="button"
      class="bg-primary px-3 py-1.5 text-sm font-medium text-on-primary disabled:opacity-40"
      disabled={saving || loading || !dirty}
      data-modal-primary
      onclick={() => void save()}
    >
      {#if saving}
        <CioSpinner size={13} class="mr-1 inline animate-spin" aria-hidden="true" />
      {/if}
      Save env
    </button>
  {/snippet}
</DockableModal>
