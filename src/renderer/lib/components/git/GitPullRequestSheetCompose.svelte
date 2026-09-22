<script lang="ts">
  import { CircleCheck, Loader2, Sparkles, TriangleAlert } from '@lucide/svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import { modelKey } from '$lib/model-keys'
  import { baseUrlProviderStore } from '$lib/stores/base-url-providers.svelte'
  import { prComposeAgentSettings } from '$lib/stores/pr-compose-agent-settings.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { providerIssueTitle } from '$shared/provider-issue'
  import { DEFAULT_THINKING_LEVEL, resolveDefaultThinkingLevel } from '$shared/thinking-presets'
  import type { AgentProviderIssue, ProviderCatalog, ThinkingLevel } from '$shared/types'

  /**
   * Compose PR: pick the agent that drafts the title and description, and run it.
   *
   * The picker sits directly in the block rather than inside a menu. A menu
   * would be a second overlay around a component that is already a popover, and
   * the outer menu dismisses on the first pointerdown that lands in the portaled
   * model list, closing the picker before a model can be chosen. Every other
   * surface that offers this picker does the same thing for the same reason.
   *
   * The failure is the block's own state rather than a separate banner: the
   * helper line gives way to what went wrong, and the action beside it is
   * renamed for the state, so the user never has to hunt for the way out.
   */
  interface Props {
    projectId: string
    providers: ProviderCatalog[]
    composePhase: 'idle' | 'working' | 'complete' | 'recompose'
    /** The last compose failure, classified. Null once it is cleared. */
    issue: AgentProviderIssue | null
    onCompose: () => void
  }

  let { projectId, providers, composePhase, issue = $bindable(), onCompose }: Props = $props()

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
    // describing the state of the block the moment a different one is chosen.
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

<div class="space-y-2 rounded-lg border border-border bg-surface p-2.5">
  {#if issue}
    <div class="flex items-start gap-1.5" role="alert">
      <TriangleAlert size={11} class="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <p class="text-[0.625rem] font-semibold text-warning">
          {providerIssueTitle(issue.kind)}
        </p>
        <p class="mt-0.5 text-[0.5625rem] leading-relaxed text-warning select-text">
          {issue.message}
        </p>
      </div>
    </div>
  {:else}
    <p class="text-[0.625rem] text-muted">Let the agent draft the PR for you.</p>
  {/if}

  <div class="flex flex-wrap items-center justify-end gap-1.5">
    <ModelPicker
      {providers}
      {projectId}
      harnessId={prComposeAgentSettings.selection?.harnessId ?? ''}
      providerId={prComposeAgentSettings.selection?.providerId ?? ''}
      modelId={prComposeAgentSettings.selection?.modelId ?? ''}
      accountId={prComposeAgentSettings.selection?.accountId}
      label={prComposeAgentSettings.selection ? undefined : 'Choose model'}
      favoriteModels={rendererRecovery.favoriteModels}
      recentModels={rendererRecovery.recentModels}
      onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
      side="top"
      variant="action"
      disabled={working}
      onSelect={chooseComposeModel}
      thinkingLevel={prComposeAgentSettings.selection?.thinkingLevel ?? null}
      onSelectThinking={chooseComposeThinking}
      onToggleFavorite={(providerId, modelId, harnessId) =>
        rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
      onReorderFavorite={(draggedKey, targetKey, position) =>
        rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
    />
    <button
      type="button"
      class="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-50"
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
</div>
