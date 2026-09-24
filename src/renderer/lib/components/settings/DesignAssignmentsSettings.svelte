<script lang="ts">
  import { ChevronDown, Loader2, Plus, Sparkles, Trash2 } from '@lucide/svelte'
  import { onMount } from 'svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { modelKey } from '$lib/model-keys'
  import { harnessAccountCache } from '$lib/stores/harness-accounts'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import {
    DESIGN_ASSIGNMENT_INSTRUCTIONS_MAX_LENGTH,
    DESIGN_ASSIGNMENT_LABEL_MAX_LENGTH,
    MAX_DESIGN_ASSIGNMENTS,
    uniqueDesignAssignmentId
  } from '$shared/design-assignments'
  import { INBOX_PROJECT_ID } from '$shared/types'
  import type {
    AgentModelSelection,
    AppConfig,
    AppConfigPatch,
    DesignAssignment,
    ProviderCatalog,
    ThinkingLevel
  } from '$shared/types'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import EmptyState from '../ui/EmptyState.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'

  /**
   * Design assignments: the user names the model that does each kind of design
   * work, and nothing here is chosen for them.
   *
   * A row is only written once it names a model, because the config the agent
   * reads has to be executable: a half-written assignment would either be
   * refused at delegation time or, worse, sent to a model the user never chose.
   */
  interface Props {
    config: AppConfig
    settingsReady: boolean
    updateConfig: (patch: AppConfigPatch) => Promise<void>
  }

  let { config, settingsReady, updateConfig }: Props = $props()

  let catalogs = $state<ProviderCatalog[]>([])
  let loading = $state(true)
  let error = $state('')
  /** The work name being typed in the add form. */
  let draftLabel = $state('')
  /** The model picked for the work being added. A row needs one to be saved. */
  let draftSelection = $state<AgentModelSelection | null>(null)
  /** Rows whose guidance field is open; one at a time keeps the list scannable. */
  let expandedId = $state<string | null>(null)
  /** In-flight text edits, keyed by assignment id, so typing never writes config. */
  let labelDrafts = $state<Record<string, string>>({})
  let guidanceDrafts = $state<Record<string, string>>({})
  /** The assignment a removal is waiting to confirm. */
  let pendingRemoval = $state<DesignAssignment | null>(null)

  /** Harness catalogs are app-wide, so this holds with no project selected. */
  const catalogProjectId = $derived(rendererRecovery.selectedProjectId ?? INBOX_PROJECT_ID)
  const assignments = $derived(config.design?.assignments ?? [])
  const atCapacity = $derived(assignments.length >= MAX_DESIGN_ASSIGNMENTS)
  const draftLabelTooLong = $derived(draftLabel.length > DESIGN_ASSIGNMENT_LABEL_MAX_LENGTH)
  const canAdd = $derived(
    settingsReady &&
      !atCapacity &&
      draftLabel.trim().length > 0 &&
      !draftLabelTooLong &&
      draftSelection !== null
  )

  function labelOf(assignment: DesignAssignment): string {
    return labelDrafts[assignment.id] ?? assignment.label
  }

  function guidanceOf(assignment: DesignAssignment): string {
    return guidanceDrafts[assignment.id] ?? assignment.instructions ?? ''
  }

  async function persist(next: DesignAssignment[], failureMessage: string): Promise<void> {
    try {
      await updateConfig({ design: { assignments: next } })
    } catch (saveError) {
      reportError(saveError, failureMessage)
    }
  }

  function replace(
    assignment: DesignAssignment,
    changes: Partial<DesignAssignment>
  ): DesignAssignment[] {
    return assignments.map((entry) =>
      entry.id === assignment.id ? { ...entry, ...changes } : entry
    )
  }

  async function selectModel(
    assignment: DesignAssignment,
    providerId: string,
    modelId: string,
    harnessId: string,
    accountId?: string
  ): Promise<void> {
    rendererRecovery.addRecentModel(modelKey(harnessId, providerId, modelId))
    // The thinking level belongs to the model that was replaced, so it is only
    // carried over when the new model is the same one on the same harness.
    const previous = assignment.selection
    const sameModel =
      previous.harnessId === harnessId &&
      previous.providerId === providerId &&
      previous.modelId === modelId
    const selection: AgentModelSelection = {
      harnessId,
      providerId,
      modelId,
      ...(accountId ? { accountId } : {}),
      ...(sameModel && previous.thinkingLevel ? { thinkingLevel: previous.thinkingLevel } : {})
    }
    await persist(
      replace(assignment, { selection }),
      'The design assignment model could not be saved.'
    )
  }

  async function selectThinking(assignment: DesignAssignment, level: ThinkingLevel): Promise<void> {
    await persist(
      replace(assignment, { selection: { ...assignment.selection, thinkingLevel: level } }),
      'The design assignment thinking level could not be saved.'
    )
  }

  async function commitLabel(assignment: DesignAssignment): Promise<void> {
    const next = (labelDrafts[assignment.id] ?? assignment.label).trim()
    if (next.length === 0 || next === assignment.label) {
      const cleared = { ...labelDrafts }
      delete cleared[assignment.id]
      labelDrafts = cleared
      return
    }
    await persist(
      replace(assignment, { label: next.slice(0, DESIGN_ASSIGNMENT_LABEL_MAX_LENGTH) }),
      'The design assignment name could not be saved.'
    )
    const cleared = { ...labelDrafts }
    delete cleared[assignment.id]
    labelDrafts = cleared
  }

  async function commitGuidance(assignment: DesignAssignment): Promise<void> {
    const typed = (guidanceDrafts[assignment.id] ?? assignment.instructions ?? '').slice(
      0,
      DESIGN_ASSIGNMENT_INSTRUCTIONS_MAX_LENGTH
    )
    if (typed === (assignment.instructions ?? '')) return
    const next = assignments.map((entry) => {
      if (entry.id !== assignment.id) return entry
      if (typed.trim().length === 0) {
        const { instructions: _cleared, ...withoutGuidance } = entry
        return withoutGuidance
      }
      return { ...entry, instructions: typed }
    })
    await persist(next, 'The design assignment guidance could not be saved.')
    const cleared = { ...guidanceDrafts }
    delete cleared[assignment.id]
    guidanceDrafts = cleared
  }

  async function addAssignment(): Promise<void> {
    if (!canAdd || !draftSelection) return
    const label = draftLabel.trim().slice(0, DESIGN_ASSIGNMENT_LABEL_MAX_LENGTH)
    await persist(
      [
        ...assignments,
        {
          id: uniqueDesignAssignmentId(config.design, label),
          label,
          selection: draftSelection
        }
      ],
      'The design assignment could not be saved.'
    )
    draftLabel = ''
    draftSelection = null
  }

  async function confirmRemoval(): Promise<void> {
    const target = pendingRemoval
    pendingRemoval = null
    if (!target) return
    expandedId = expandedId === target.id ? null : expandedId
    await persist(
      assignments.filter((entry) => entry.id !== target.id),
      'The design assignment could not be removed.'
    )
  }

  onMount(() => {
    const load = async (): Promise<void> => {
      loading = true
      error = ''
      try {
        const [, projectCatalogs] = await Promise.all([
          harnessAccountCache.warm(),
          invoke('agent:listProviders', catalogProjectId)
        ])
        catalogs = projectCatalogs
      } catch (loadError) {
        error =
          loadError instanceof Error ? loadError.message : 'Design assignments could not be loaded.'
      } finally {
        loading = false
      }
    }
    void load()
  })
</script>

<div class="space-y-4">
  <div class="rounded-xl border bg-surface p-4">
    <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">Assigned models</h3>
    <p class="mt-2 text-xs leading-relaxed text-dimmed">
      Name each kind of design work and pick the model that does it: product copy, an SEO pass, a
      script, a storyboard, the prompts a generator is given. A design session delegates that work
      to the model you pick here, and it never picks one itself. The model answers in words, so
      pictures, video and sound come from a generation capability instead: install one in Utilities
      and the session uses it, then saves the result into the design as a file. With nothing
      assigned, the agent says which work needs a model instead of improvising one.
    </p>
  </div>

  {#if error}
    <p
      class="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-xs text-danger"
      role="alert"
    >
      {error}
    </p>
  {/if}

  {#if loading}
    <div class="flex items-center gap-2 rounded-xl border bg-surface px-4 py-3 text-xs text-muted">
      <Loader2 size={14} class="animate-spin" /> Loading harness catalogs…
    </div>
  {:else if catalogs.length === 0 && assignments.length === 0}
    <div class="rounded-xl border border-dashed bg-surface">
      <EmptyState
        icon={Sparkles}
        title="No harness installed"
        description="Install a harness and sign in to assign a model to design work."
      />
    </div>
  {:else}
    {#if assignments.length > 0}
      <div class="rounded-xl border bg-surface">
        <div class="divide-y">
          {#each assignments as assignment (assignment.id)}
            <div class="p-4">
              <div class="flex flex-wrap items-start gap-3">
                <div class="min-w-0 flex-1">
                  <label
                    class="block text-xs text-muted"
                    for={`design-assignment-${assignment.id}`}
                  >
                    Work
                  </label>
                  <input
                    id={`design-assignment-${assignment.id}`}
                    class="mt-1 w-full rounded-lg border bg-elevated px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
                    type="text"
                    maxlength={DESIGN_ASSIGNMENT_LABEL_MAX_LENGTH}
                    value={labelOf(assignment)}
                    disabled={!settingsReady}
                    oninput={(event) => {
                      labelDrafts = { ...labelDrafts, [assignment.id]: event.currentTarget.value }
                    }}
                    onblur={() => void commitLabel(assignment)}
                    onkeydown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                    }}
                  />
                  <p
                    class="mt-1 font-mono text-xs text-dimmed"
                    title="The handle a design session uses to delegate this work"
                  >
                    {assignment.id}
                  </p>
                </div>

                <div class="flex w-64 shrink-0 items-center gap-1.5">
                  <div class="min-w-0 flex-1">
                    <ModelPicker
                      providers={catalogs}
                      projectId={catalogProjectId}
                      harnessId={assignment.selection.harnessId}
                      providerId={assignment.selection.providerId}
                      modelId={assignment.selection.modelId}
                      accountId={assignment.selection.accountId}
                      favoriteModels={rendererRecovery.favoriteModels}
                      recentModels={rendererRecovery.recentModels}
                      onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
                      side="bottom"
                      variant="field"
                      label="Model"
                      disabled={!settingsReady || catalogs.length === 0}
                      onSelect={(providerId, modelId, harnessId, accountId) =>
                        void selectModel(assignment, providerId, modelId, harnessId, accountId)}
                      thinkingLevel={assignment.selection.thinkingLevel}
                      onSelectThinking={(level) => void selectThinking(assignment, level)}
                      onToggleFavorite={(providerId, modelId, harnessId) =>
                        rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
                      onReorderFavorite={(draggedKey, targetKey, position) =>
                        rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
                    />
                  </div>
                  <button
                    type="button"
                    class="rounded-lg p-2 text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
                    title={`Remove the ${assignment.label} assignment`}
                    aria-label={`Remove the ${assignment.label} assignment`}
                    disabled={!settingsReady}
                    onclick={() => {
                      pendingRemoval = assignment
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              <div class="mt-2">
                <button
                  type="button"
                  class="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
                  aria-expanded={expandedId === assignment.id}
                  title={`Standing guidance handed to ${assignment.label} with every request`}
                  onclick={() => {
                    expandedId = expandedId === assignment.id ? null : assignment.id
                  }}
                >
                  <ChevronDown
                    size={12}
                    class={expandedId === assignment.id
                      ? 'rotate-180 transition-transform'
                      : 'transition-transform'}
                  />
                  {assignment.instructions ? 'Guidance' : 'Add guidance'}
                </button>
                {#if expandedId === assignment.id}
                  <textarea
                    class="mt-1.5 h-20 w-full resize-y rounded-lg border bg-elevated px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-primary disabled:opacity-60"
                    maxlength={DESIGN_ASSIGNMENT_INSTRUCTIONS_MAX_LENGTH}
                    placeholder="Say how this work should be done: size, format, tone, anything the model should always follow."
                    aria-label={`Standing guidance for ${assignment.label}`}
                    value={guidanceOf(assignment)}
                    disabled={!settingsReady}
                    oninput={(event) => {
                      guidanceDrafts = {
                        ...guidanceDrafts,
                        [assignment.id]: event.currentTarget.value
                      }
                    }}
                    onblur={() => void commitGuidance(assignment)}></textarea>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <div class="rounded-xl border bg-surface p-4">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">Add an assignment</h3>
      <div class="mt-3 flex flex-wrap items-start gap-3">
        <div class="min-w-0 flex-1">
          <label class="block text-xs text-muted" for="design-assignment-new">Work</label>
          <input
            id="design-assignment-new"
            class="mt-1 w-full rounded-lg border bg-elevated px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
            type="text"
            placeholder="Product copy"
            maxlength={DESIGN_ASSIGNMENT_LABEL_MAX_LENGTH}
            bind:value={draftLabel}
            disabled={!settingsReady || atCapacity}
          />
        </div>
        <div class="w-64 shrink-0">
          <span class="block text-xs text-muted">Model</span>
          <div class="mt-1">
            <ModelPicker
              providers={catalogs}
              projectId={catalogProjectId}
              harnessId={draftSelection?.harnessId ?? ''}
              providerId={draftSelection?.providerId ?? ''}
              modelId={draftSelection?.modelId ?? ''}
              accountId={draftSelection?.accountId}
              favoriteModels={rendererRecovery.favoriteModels}
              recentModels={rendererRecovery.recentModels}
              onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
              side="bottom"
              variant="field"
              fullWidth
              label="Choose model"
              disabled={!settingsReady || atCapacity || catalogs.length === 0}
              onSelect={(providerId, modelId, harnessId, accountId) => {
                rendererRecovery.addRecentModel(modelKey(harnessId, providerId, modelId))
                draftSelection = { harnessId, providerId, modelId, accountId }
              }}
              thinkingLevel={draftSelection?.thinkingLevel}
              onSelectThinking={(level) => {
                draftSelection = draftSelection ? { ...draftSelection, thinkingLevel: level } : null
              }}
              onToggleFavorite={(providerId, modelId, harnessId) =>
                rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
              onReorderFavorite={(draggedKey, targetKey, position) =>
                rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
            />
          </div>
        </div>
        <button
          type="button"
          class="mt-5 flex items-center gap-1.5 rounded-lg border bg-elevated px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-overlay disabled:opacity-50"
          disabled={!canAdd}
          title="Add this design assignment"
          aria-label="Add this design assignment"
          onclick={() => void addAssignment()}
        >
          <Plus size={13} /> Add
        </button>
      </div>
      <p class="mt-2 text-xs text-dimmed">
        {#if atCapacity}
          The list holds {MAX_DESIGN_ASSIGNMENTS} assignments, which is the maximum. Remove one to add
          another.
        {:else if draftLabelTooLong}
          Keep the work name under {DESIGN_ASSIGNMENT_LABEL_MAX_LENGTH} characters.
        {:else if draftLabel.trim().length === 0}
          Name the work first.
        {:else if !draftSelection}
          Pick the model that does this work; the assignment is saved with it.
        {:else}
          The handle a design session types to reach this model is generated from the name.
        {/if}
      </p>
    </div>
  {/if}
</div>

<ConfirmDialog
  open={pendingRemoval !== null}
  title="Remove this design assignment?"
  confirmLabel="Remove assignment"
  variant="danger"
  disabled={!settingsReady}
  onCancel={() => {
    pendingRemoval = null
  }}
  onConfirm={confirmRemoval}
>
  {#if pendingRemoval}
    <p>
      A design session will no longer be able to delegate <strong>{pendingRemoval.label}</strong> to the
      model you assigned, and it will ask you for a model instead. The model itself is untouched.
    </p>
  {/if}
</ConfirmDialog>
