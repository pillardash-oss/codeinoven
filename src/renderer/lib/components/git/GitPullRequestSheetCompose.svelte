<script lang="ts">
  import { DropdownMenu } from 'bits-ui'
  import { CircleCheck, Loader2, Sparkles } from '@lucide/svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import { modelKey } from '$lib/model-keys'
  import { baseUrlProviderStore } from '$lib/stores/base-url-providers.svelte'
  import { prComposeAgentSettings } from '$lib/stores/pr-compose-agent-settings.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { DEFAULT_THINKING_LEVEL, resolveDefaultThinkingLevel } from '$shared/thinking-presets'
  import type { AgentProviderIssue, ProviderCatalog, ThinkingLevel } from '$shared/types'

  /**
   * Compose PR: pick the agent that drafts the title and description, and run it.
   *
   * This renders the sheet footer's bottom-left trigger only. The panel itself
   * lives in the sheet body, because an alert needs the width to state what went
   * wrong and this button needs to sit with the sheet's other actions.
   *
   * The model picker belongs inside the menu content, as it always has. Its
   * popover is portaled to the document, so it is not a DOM descendant of this
   * menu   and bits-ui only lets the topmost dismissable layer react to an
   * outside pointerdown, which is the popover while it is open. The menu
   * therefore survives a click on a model, and a model can be chosen before the
   * Compose action is pressed.
   */
  interface Props {
    projectId: string
    providers: ProviderCatalog[]
    composePhase: 'idle' | 'working' | 'complete' | 'recompose'
    /** The last compose failure, classified. Null once it is cleared. */
    issue: AgentProviderIssue | null
    /** Open state of the compose menu. The sheet binds this so the failure
     *  notice can open the menu on the user's behalf. */
    open?: boolean
    onCompose: () => void
  }

  let {
    projectId,
    providers,
    composePhase,
    issue = $bindable(),
    open = $bindable(false),
    onCompose
  }: Props = $props()

  function chooseComposeModel(
    providerId: string,
    modelId: string,
    harnessId: string,
    accountId?: string
  ): void {
    const provider = providers.find(
      (candidate) => candidate.harnessId === harnessId && candidate.id === providerId
    )
    const model = provider?.models.find((candidate) => candidate.id === modelId)
    const thinkingLevel =
      resolveDefaultThinkingLevel(
        model?.thinkingPresets,
        baseUrlProviderStore.defaultThinkingLevel(harnessId, providerId, modelId),
        prComposeAgentSettings.selection?.thinkingLevel
      ) ??
      prComposeAgentSettings.selection?.thinkingLevel ??
      DEFAULT_THINKING_LEVEL
    prComposeAgentSettings.selectModel({
      harnessId,
      providerId,
      modelId,
      accountId,
      thinkingLevel
    })
    // The failure belonged to the harness that just got replaced, so it stops
    // describing the state of the sheet the moment a different one is chosen.
    issue = null
  }

  function chooseComposeThinking(level: ThinkingLevel): void {
    prComposeAgentSettings.selectThinking(level)
  }

  const working = $derived(composePhase === 'working')
  const actionLabel = $derived(
    working
      ? 'Composing…'
      : composePhase === 'complete'
        ? 'Complete'
        : issue
          ? 'Retry'
          : composePhase === 'recompose'
            ? 'Recompose'
            : 'Compose'
  )
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger
    class="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-50"
    aria-label="Compose with agent"
    title="Compose the title and description with an agent"
    disabled={working}
  >
    {#if working}
      <Loader2 size={11} class="animate-spin" />
      <span>Composing…</span>
    {:else if composePhase === 'complete'}
      <CircleCheck size={11} class="text-success" />
      <span>Complete</span>
    {:else}
      <Sparkles size={11} />
      <span>{composePhase === 'recompose' ? 'Recompose' : 'Compose with agent'}</span>
    {/if}
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="top"
      align="start"
      sideOffset={6}
      collisionPadding={8}
      class="z-90 w-72 rounded-xl border border-border bg-surface p-2 shadow-xl"
    >
      <div class="space-y-1.5">
        <div>
          <p class="mb-1 px-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide text-muted">
            Compose model
          </p>
          <ModelPicker
            {providers}
            {projectId}
            harnessId={prComposeAgentSettings.selection?.harnessId ?? ''}
            providerId={prComposeAgentSettings.selection?.providerId ?? ''}
            modelId={prComposeAgentSettings.selection?.modelId ?? ''}
            accountId={prComposeAgentSettings.selection?.accountId}
            label={prComposeAgentSettings.selection ? 'Change' : 'Choose a model'}
            favoriteModels={rendererRecovery.favoriteModels}
            recentModels={rendererRecovery.recentModels}
            onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
            side="top"
            variant="action"
            fullWidth
            disabled={working}
            onSelect={chooseComposeModel}
            thinkingLevel={prComposeAgentSettings.selection?.thinkingLevel ?? null}
            onSelectThinking={chooseComposeThinking}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
          />
        </div>
        <button
          type="button"
          class="flex h-8 w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-50"
          title={issue
            ? 'Run Compose PR again with the selected agent'
            : 'Draft the title and description with an agent'}
          disabled={working || !prComposeAgentSettings.selection}
          onclick={onCompose}
        >
          {#if working}
            <Loader2 size={12} class="animate-spin" />
          {:else if composePhase === 'complete'}
            <CircleCheck size={12} />
          {:else}
            <Sparkles size={12} />
          {/if}
          <span>{actionLabel}</span>
        </button>
      </div>
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
