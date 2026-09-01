<script lang="ts">
  import {
    Copy,
    FileTerminal,
    Pencil,
    Play,
    Plus,
    Square,
    Trash2,
    Variable,
    X
  } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import { PROJECT_COLORS } from '$lib/project-colors'
  import ActionTerminal from './ActionTerminal.svelte'
  import { projectActionsState } from '$lib/stores/project-actions.svelte'
  import type {
    ProjectAction,
    ProjectActionInput,
    ProjectActionVariable
  } from '$shared/project-actions'

  interface Props {
    projectId: string
    scopeBucketId?: string
  }
  let { projectId, scopeBucketId }: Props = $props()
  let editorOpen = $state(false)
  let editing = $state<ProjectAction | null>(null)
  let name = $state('')
  let script = $state('')
  const SCRIPT_PLACEHOLDER = `bun install\ncd apps/mobile\nbun run deploy --message "$m"`
  let variables = $state<ProjectActionVariable[]>([])
  let color = $state<string | null>(null)
  let runTarget = $state<ProjectAction | null>(null)
  let runValues = $state<Record<string, string>>({})
  let deleteTarget = $state<ProjectAction | null>(null)
  let saving = $state(false)
  let error = $state<string | null>(null)

  $effect(() => {
    void projectActionsState.load(projectId)
  })
  let actions = $derived(projectActionsState.actions(projectId))

  function openEditor(action: ProjectAction | null = null): void {
    editing = action
    name = action?.name ?? ''
    script = action?.script ?? ''
    variables = action?.variables.map((variable) => ({ ...variable })) ?? []
    color = action?.color ?? null
    error = null
    editorOpen = true
  }
  function addVariable(): void {
    variables = [...variables, { name: '', label: '', required: true }]
  }
  function removeVariable(index: number): void {
    variables = variables.filter((_, variableIndex) => variableIndex !== index)
  }
  function updateVariable(index: number, patch: Partial<ProjectActionVariable>): void {
    variables = variables.map((variable, variableIndex) =>
      variableIndex === index ? { ...variable, ...patch } : variable
    )
  }
  async function save(): Promise<void> {
    saving = true
    error = null
    try {
      const input: ProjectActionInput = { name, script, variables, color }
      await projectActionsState.save(projectId, editing?.id ?? null, input)
      editorOpen = false
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason)
    } finally {
      saving = false
    }
  }
  function requestRun(action: ProjectAction): void {
    if (action.variables.length === 0) {
      projectActionsState.start(action, {})
      return
    }
    runValues = Object.fromEntries(action.variables.map((variable) => [variable.name, '']))
    runTarget = action
  }
  function startRun(): void {
    if (!runTarget) return
    projectActionsState.start(runTarget, runValues)
    runTarget = null
  }
  function duplicate(action: ProjectAction): void {
    void projectActionsState.save(
      projectId,
      null,
      {
        name: action.name ? `${action.name} (copy)` : '',
        script: action.script,
        variables: action.variables.map((variable) => ({ ...variable })),
        color: action.color ?? null
      },
      action.id
    )
  }
  let draggingId = $state<string | null>(null)
  let dragStartOrder: string[] | null = null
  function dragStart(action: ProjectAction, event: DragEvent): void {
    dragStartOrder = actions.map((entry) => entry.id)
    draggingId = action.id
    const transfer = event.dataTransfer
    if (transfer) {
      transfer.effectAllowed = 'move'
      transfer.setData('text/plain', action.id)
    }
  }
  function dragOver(action: ProjectAction, event: DragEvent): void {
    if (!draggingId || draggingId === action.id) return
    event.preventDefault()
    const transfer = event.dataTransfer
    if (transfer) transfer.dropEffect = 'move'
    const current = actions
    const from = current.findIndex((entry) => entry.id === draggingId)
    const to = current.findIndex((entry) => entry.id === action.id)
    if (from === -1 || to === -1) return
    const next = [...current]
    next.splice(to, 0, next.splice(from, 1)[0])
    projectActionsState.reorderLocal(projectId, next)
  }
  function dragEnd(): void {
    const finalOrder = actions.map((entry) => entry.id)
    const changed =
      dragStartOrder !== null &&
      (dragStartOrder.length !== finalOrder.length ||
        dragStartOrder.some((id, index) => id !== finalOrder[index]))
    draggingId = null
    dragStartOrder = null
    if (changed) void projectActionsState.reorder(projectId, finalOrder)
  }
  function moveBy(action: ProjectAction, delta: number): void {
    const current = actions
    const from = current.findIndex((entry) => entry.id === action.id)
    const to = from + delta
    if (from === -1 || to < 0 || to >= current.length) return
    const next = [...current]
    const moved = next[from]
    next[from] = next[to]
    next[to] = moved
    projectActionsState.reorderLocal(projectId, next)
    void projectActionsState.reorder(
      projectId,
      next.map((entry) => entry.id)
    )
  }
</script>

<section class="flex h-full min-h-0 flex-col bg-app" aria-label="Actions">
  <header class="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
    <div class="flex items-center gap-2">
      <FileTerminal size={15} />
      <h2 class="text-xs font-semibold">Actions</h2>
    </div>
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-elevated hover:text-foreground"
      title="Add action"
      aria-label="Add action"
      onclick={() => openEditor()}><Plus size={15} /></button
    >
  </header>
  <div class="min-h-0 flex-1 overflow-y-auto p-2">
    {#if actions.length === 0}
      <div class="flex h-full min-h-48 flex-col items-center justify-center px-6 text-center">
        <FileTerminal size={24} class="text-dimmed" />
        <p class="mt-3 text-sm font-semibold">No actions yet</p>
        <p class="mt-1 text-xs text-muted">
          Save a command you run often, then launch it without opening a terminal.
        </p>
        <button
          type="button"
          class="mt-4 h-8 rounded-lg bg-primary px-3 text-xs font-semibold text-on-primary hover:bg-primary-hover"
          onclick={() => openEditor()}>Add action</button
        >
      </div>
    {:else}
      <div class="space-y-1">
        {#each actions as action (action.id)}
          {@const run = projectActionsState.run(action.id)}
          <article
            class="group cursor-grab overflow-hidden rounded-lg border border-transparent bg-surface hover:border-border active:cursor-grabbing {draggingId ===
            action.id
              ? 'opacity-50'
              : ''}"
            style={action.color ? `border-left: 3px solid ${action.color}` : undefined}
            draggable="true"
            ondragstart={(event) => dragStart(action, event)}
            ondragover={(event) => dragOver(action, event)}
            ondragend={dragEnd}
          >
            <div
              class="flex min-w-0 items-center gap-2 px-2 py-2"
              role="button"
              tabindex="0"
              onclick={() => run && projectActionsState.toggle(action.id)}
              onkeydown={(event) => {
                if (run && (event.key === 'Enter' || event.key === ' '))
                  projectActionsState.toggle(action.id)
                else if (event.altKey && event.key === 'ArrowUp') {
                  event.preventDefault()
                  moveBy(action, -1)
                } else if (event.altKey && event.key === 'ArrowDown') {
                  event.preventDefault()
                  moveBy(action, 1)
                }
              }}
            >
              <span
                class="h-2 w-2 shrink-0 rounded-full {run?.running
                  ? 'bg-thread-working'
                  : 'bg-raised'}"
                title={run?.running ? 'Running' : 'Idle'}
              ></span>
              <div class="min-w-0 flex-1">
                <p class="truncate text-xs font-semibold text-foreground">
                  {action.name || action.script}
                </p>
                {#if action.name}<p class="truncate font-mono text-[10px] text-muted">
                    {action.script}
                  </p>{/if}
              </div>
              <div
                class="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
              >
                <button
                  type="button"
                  class="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-foreground"
                  title={run?.running ? 'Stop action' : 'Run action'}
                  aria-label={run?.running
                    ? `Stop ${action.name || 'action'}`
                    : `Run ${action.name || 'action'}`}
                  onclick={(event) => {
                    event.stopPropagation()
                    if (run?.running) {
                      void projectActionsState.stop(action.id)
                    } else {
                      requestRun(action)
                    }
                  }}
                  >{#if run?.running}<Square size={13} fill="currentColor" />{:else}<Play
                      size={13}
                      fill="currentColor"
                    />{/if}</button
                >
                <button
                  type="button"
                  class="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-foreground"
                  title="Edit action"
                  aria-label={`Edit ${action.name || 'action'}`}
                  onclick={(event) => {
                    event.stopPropagation()
                    openEditor(action)
                  }}><Pencil size={13} /></button
                >
                <button
                  type="button"
                  class="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-foreground"
                  title="Duplicate action"
                  aria-label={`Duplicate ${action.name || 'action'}`}
                  onclick={(event) => {
                    event.stopPropagation()
                    duplicate(action)
                  }}><Copy size={13} /></button
                >
                <button
                  type="button"
                  class="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-danger/10 hover:text-danger"
                  title="Delete action"
                  aria-label={`Delete ${action.name || 'action'}`}
                  onclick={(event) => {
                    event.stopPropagation()
                    deleteTarget = action
                  }}><Trash2 size={13} /></button
                >
              </div>
            </div>
            {#if run?.expanded}
              <div class="h-52 border-t border-border">
                {#key run.terminalId}<ActionTerminal
                    terminalId={run.terminalId}
                    {projectId}
                    {scopeBucketId}
                    script={run.script}
                    variables={run.variables}
                  />{/key}
              </div>
            {/if}
          </article>
        {/each}
      </div>
    {/if}
  </div>
</section>

<Modal
  open={editorOpen}
  title={editing ? 'Edit action' : 'Add action'}
  size="lg"
  onClose={() => (editorOpen = false)}
>
  <div class="space-y-4">
    <label class="block text-xs font-semibold"
      >Name <span class="font-normal text-muted">Optional</span><input
        class="mt-1 h-9 w-full rounded-lg border border-border bg-elevated px-3 text-sm outline-none focus:border-primary"
        bind:value={name}
        placeholder="Deploy OTA"
      /></label
    >
    <label class="block text-xs font-semibold"
      >Bash script<textarea
        class="mt-1 min-h-32 w-full resize-y rounded-lg border border-border bg-terminal-background p-3 font-mono text-xs text-terminal-foreground outline-none focus:border-primary"
        bind:value={script}
        placeholder={SCRIPT_PLACEHOLDER}></textarea></label
    >
    <div>
      <p class="text-xs font-semibold">Label colour</p>
      <div class="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          class="flex h-5 w-5 items-center justify-center rounded-full border-2 transition-transform hover:scale-110 {color ===
          null
            ? 'border-foreground'
            : 'border-border'}"
          title="No colour"
          aria-label="No colour"
          onclick={() => (color = null)}><X size={11} class="text-muted" /></button
        >
        {#each PROJECT_COLORS as option (option.value)}
          <button
            type="button"
            class="h-5 w-5 rounded-full border-2 transition-transform hover:scale-110 {color ===
            option.value
              ? 'border-foreground'
              : 'border-transparent'}"
            style="background-color: {option.value}"
            title={option.name}
            aria-label={`${option.name} label colour`}
            onclick={() => (color = option.value)}
          ></button>
        {/each}
      </div>
      <p class="mt-1.5 text-[11px] text-muted">
        The colour shows as the entry's left border — group similar scripts together.
      </p>
    </div>
    <div>
      <div class="flex items-center justify-between">
        <div>
          <p class="text-xs font-semibold">Variables</p>
          <p class="text-[11px] text-muted">Values are exposed as environment variables.</p>
        </div>
        <button
          type="button"
          class="flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-semibold hover:bg-elevated"
          onclick={addVariable}><Variable size={13} /> Add variable</button
        >
      </div>
      <div class="mt-2 space-y-2">
        {#each variables as variable, index (index)}<div
            class="grid grid-cols-[1fr_1fr_auto_auto] items-end gap-2 rounded-lg bg-elevated p-2"
          >
            <label class="text-[10px] font-semibold text-muted"
              >Name<input
                class="mt-1 h-8 w-full rounded-md border border-border bg-surface px-2 font-mono text-xs"
                value={variable.name}
                oninput={(event) => updateVariable(index, { name: event.currentTarget.value })}
                placeholder="m"
              /></label
            ><label class="text-[10px] font-semibold text-muted"
              >Prompt label<input
                class="mt-1 h-8 w-full rounded-md border border-border bg-surface px-2 text-xs"
                value={variable.label}
                oninput={(event) => updateVariable(index, { label: event.currentTarget.value })}
                placeholder="Commit message"
              /></label
            ><label class="flex h-8 items-center gap-2 text-[10px] font-semibold text-muted"
              ><Switch
                checked={variable.required}
                onchange={(required) => updateVariable(index, { required })}
                aria-label={`Require ${variable.name || 'variable'}`}
              /> Required</label
            ><button
              type="button"
              class="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-danger/10 hover:text-danger"
              title="Remove variable"
              aria-label="Remove variable"
              onclick={() => removeVariable(index)}><X size={13} /></button
            >
          </div>{/each}
      </div>
    </div>
    {#if error}<p class="text-xs text-danger">{error}</p>{/if}
    <div class="flex justify-end gap-2">
      <button
        type="button"
        class="h-9 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-elevated"
        onclick={() => (editorOpen = false)}>Cancel</button
      ><button
        type="button"
        class="h-9 rounded-lg bg-primary px-3 text-xs font-semibold text-on-primary disabled:opacity-50"
        disabled={!script.trim() || saving}
        onclick={() => void save()}>{saving ? 'Saving…' : 'Save action'}</button
      >
    </div>
  </div>
</Modal>

<Modal
  open={runTarget !== null}
  title={`Run ${runTarget?.name || 'action'}`}
  onClose={() => (runTarget = null)}
>
  <div class="space-y-3">
    {#each runTarget?.variables ?? [] as variable (variable.name)}<label
        class="block text-xs font-semibold"
        >{variable.label || variable.name}<input
          class="mt-1 h-9 w-full rounded-lg border border-border bg-elevated px-3 text-sm outline-none focus:border-primary"
          value={runValues[variable.name] ?? ''}
          oninput={(event) =>
            (runValues = { ...runValues, [variable.name]: event.currentTarget.value })}
          required={variable.required}
        /></label
      >{/each}
    <div class="flex justify-end gap-2 pt-2">
      <button
        type="button"
        class="h-9 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-elevated"
        onclick={() => (runTarget = null)}>Cancel</button
      ><button
        type="button"
        class="h-9 rounded-lg bg-primary px-3 text-xs font-semibold text-on-primary disabled:opacity-50"
        disabled={(runTarget?.variables ?? []).some(
          (variable) => variable.required && !runValues[variable.name]?.trim()
        )}
        onclick={startRun}>Run action</button
      >
    </div>
  </div>
</Modal>

<Modal open={deleteTarget !== null} title="Delete action?" onClose={() => (deleteTarget = null)}
  ><p class="text-sm text-muted">
    This permanently removes "{deleteTarget?.name || deleteTarget?.script}".
  </p>
  <div class="mt-5 flex justify-end gap-2">
    <button
      type="button"
      class="h-9 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-elevated"
      onclick={() => (deleteTarget = null)}>Cancel</button
    ><button
      type="button"
      class="h-9 rounded-lg bg-danger px-3 text-xs font-semibold text-on-primary"
      onclick={async () => {
        if (deleteTarget) await projectActionsState.delete(projectId, deleteTarget.id)
        deleteTarget = null
      }}>Delete</button
    >
  </div></Modal
>
