<script lang="ts">
  import { DropdownMenu } from 'bits-ui'
  import { CircleCheck, Loader2, Sparkles, TriangleAlert } from '@lucide/svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import { modelKey } from '$lib/model-keys'
  import { baseUrlProviderStore } from '$lib/stores/base-url-providers.svelte'
  import { prComposeAgentSettings } from '$lib/stores/pr-compose-agent-settings.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { DEFAULT_THINKING_LEVEL, resolveDefaultThinkingLevel } from '$shared/thinking-presets'
  import type { ProviderCatalog, ThinkingLevel } from '$shared/types'

  interface Props {
    projectId: string
    providers: ProviderCatalog[]
    composePhase: 'idle' | 'working' | 'complete' | 'recompose'
    composeError: string
    onCompose: () => void
  }

  let {
    projectId,
    providers,
    composePhase,
    composeError = $bindable(),
    onCompose
  }: Props = $props()

  /** True while the compose dropdown is open. */
  let composeOpen = $state(false)

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
    composeError = ''
  }

  function chooseComposeThinking(level: ThinkingLevel): void {
    prComposeAgentSettings.selectThinking(level)
  }
</script>

<div class="space-y-1.5">
  {#if composeError}
    <div
      class="flex items-start gap-1.5 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1.5"
      role="alert"
    >
      <TriangleAlert size={11} class="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
      <span class="min-w-0 flex-1 text-[0.5625rem] leading-relaxed text-warning"
        >{composeError}</span
      >
      <!--
        The remedy for most compose failures is a different agent, and the
        control that chooses one   harness, provider and model   is the picker
        above. Opening it from the failure keeps the switch where the user is
        already looking instead of sending them hunting for it.
      -->
      <button
        type="button"
        class="shrink-0 cursor-pointer text-[0.5625rem] font-medium text-warning underline underline-offset-2 hover:text-foreground"
        title="Choose another harness, provider, or model for Compose PR"
        aria-label="Choose another harness, provider, or model for Compose PR"
        onclick={() => (composeOpen = true)}
      >
        Change model
      </button>
    </div>
  {/if}
  <div class="flex items-center justify-between gap-2">
    <p class="text-[0.625rem] text-muted">Let the agent draft the PR for you.</p>
    <DropdownMenu.Root bind:open={composeOpen}>
      <DropdownMenu.Trigger
        class="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-50"
        aria-label={prComposeAgentSettings.selection
          ? 'Compose with agent'
          : 'Choose a model for Compose PR'}
        title={prComposeAgentSettings.selection
          ? 'Compose the title and description with an agent'
          : 'Choose the model Compose PR will reuse'}
        disabled={composePhase === 'working'}
      >
        {#if composePhase === 'working'}
          <Loader2 size={11} class="animate-spin" />
          <span>Composing…</span>
        {:else if composePhase === 'complete'}
          <CircleCheck size={11} class="text-success" />
          <span>Complete</span>
        {:else}
          <Sparkles size={11} />
          <span>
            {prComposeAgentSettings.selection
              ? composePhase === 'recompose'
                ? 'Recompose'
                : 'Compose with agent'
              : 'Choose compose model'}
          </span>
        {/if}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          class="z-90 w-72 rounded-xl border border-border bg-surface p-2 shadow-xl"
        >
          <div class="space-y-1.5">
            <div>
              <p
                class="mb-1 px-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide text-muted"
              >
                Compose model
              </p>
              <ModelPicker
                {providers}
                {projectId}
                harnessId={prComposeAgentSettings.selection?.harnessId ?? ''}
                providerId={prComposeAgentSettings.selection?.providerId ?? ''}
                modelId={prComposeAgentSettings.selection?.modelId ?? ''}
                accountId={prComposeAgentSettings.selection?.accountId}
                label={prComposeAgentSettings.selection ? undefined : 'Choose a model'}
                favoriteModels={rendererRecovery.favoriteModels}
                recentModels={rendererRecovery.recentModels}
                onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
                side="top"
                variant="action"
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
              disabled={composePhase === 'working' || !prComposeAgentSettings.selection}
              onclick={onCompose}
            >
              {#if composePhase === 'working'}
                <Loader2 size={12} class="animate-spin" />
                <span>Composing…</span>
              {:else if composePhase === 'complete'}
                <CircleCheck size={12} />
                <span>Complete</span>
              {:else}
                <Sparkles size={12} />
                <span>{composePhase === 'recompose' ? 'Recompose' : 'Compose'}</span>
              {/if}
            </button>
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  </div>
</div>
