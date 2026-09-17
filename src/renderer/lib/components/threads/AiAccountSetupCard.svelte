<script lang="ts">
  import { Loader2, Plug, Sparkles, X } from '@lucide/svelte'
  import { harnessCatalogs, harnessHasProvider } from '$lib/ai-account'
  import { withModelSelection } from '../chats/chat-composer-settings'
  import { APP_NAME } from '$shared/brand'
  import type { ProviderCatalog, ThinkingLevel, ThreadSettings } from '$shared/types'
  import ModelPicker from '../shared/ModelPicker.svelte'

  interface Props {
    /** Display name of the harness this thread runs on, e.g. Pi. */
    harnessName: string
    /** Catalogs available to this project. */
    providers: ProviderCatalog[]
    settings: ThreadSettings
    projectId: string
    /** True while the project's harness catalogs are being re-probed. */
    refreshing?: boolean
    favoriteModels?: string[]
    recentModels?: string[]
    onRemoveRecent?: (modelKey: string) => void
    onToggleFavorite?: (providerId: string, modelId: string, harnessId: string) => void
    onReorderFavorite?: (
      draggedKey: string,
      targetKey: string,
      position: 'before' | 'after'
    ) => void
    onModelChange: (settings: ThreadSettings) => void
    onConnect: () => void
    onDismiss: () => void
  }

  let {
    harnessName,
    providers,
    settings,
    projectId,
    refreshing = false,
    favoriteModels = [],
    recentModels = [],
    onRemoveRecent,
    onToggleFavorite,
    onReorderFavorite,
    onModelChange,
    onConnect,
    onDismiss
  }: Props = $props()

  /** True once the harness reports a provider it can run a turn on. */
  let connected = $derived(harnessHasProvider(providers, settings.harnessId))
  /** Names of the providers the user just connected, for the ready-state copy. */
  let connectedNames = $derived(
    harnessCatalogs(providers, settings.harnessId)
      .filter((provider) => provider.models.length > 0)
      .map((provider) => provider.name)
      .join(', ')
  )

  function chooseModel(
    providerId: string,
    modelId: string,
    nextHarnessId: string,
    accountId?: string
  ): void {
    onModelChange(
      withModelSelection(settings, providers, {
        harnessId: nextHarnessId,
        providerId,
        modelId,
        accountId
      })
    )
  }

  function chooseThinking(level: ThinkingLevel): void {
    onModelChange({ ...settings, thinkingLevel: level })
  }
</script>

<div
  class="rounded-2xl border border-primary/25 bg-surface px-4 py-3.5 shadow-sm"
  role="status"
  aria-live="polite"
>
  <div class="flex items-start gap-3.5">
    <span
      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary"
      aria-hidden="true"
    >
      {#if connected}
        <Sparkles size={18} />
      {:else}
        <Plug size={18} />
      {/if}
    </span>

    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p class="text-sm font-semibold text-foreground">
          {connected ? 'Choose the model for this thread' : 'Connect your AI account'}
        </p>
        <span class="rounded-full bg-raised px-2 py-0.5 text-[0.625rem] font-semibold text-muted">
          {harnessName}
        </span>
      </div>

      <p class="mt-1 text-sm leading-relaxed text-muted">
        {#if !connected}
          {APP_NAME} works through the AI accounts you already have. Connect OpenAI, Anthropic, Google,
          or another provider, then pick a model and send your message.
        {:else}
          {connectedNames} connected. Pick the model this thread should use.
        {/if}
      </p>

      <div class="mt-3">
        {#if !connected}
          <button
            type="button"
            class="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-xs font-semibold text-on-primary transition-colors hover:bg-primary-hover"
            onclick={onConnect}
          >
            <Plug size={14} />
            Connect Your AI Account
          </button>
          <p class="mt-2 text-[0.6875rem] leading-relaxed text-dimmed">
            Signing in happens inside {APP_NAME}. Credentials are stored by {APP_NAME} in
            {harnessName}'s own credential file on this machine.
          </p>
        {:else if refreshing}
          <div class="flex h-9 items-center gap-2 text-xs text-muted">
            <Loader2 size={14} class="shrink-0 animate-spin" />
            <span class="truncate">Loading {connectedNames} models…</span>
          </div>
        {:else}
          <ModelPicker
            {providers}
            {projectId}
            harnessId={settings.harnessId}
            providerId={settings.providerId}
            modelId={settings.modelId}
            accountId={settings.accountId}
            {favoriteModels}
            {recentModels}
            {onRemoveRecent}
            side="top"
            variant="field"
            label="Choose a model"
            onSelect={chooseModel}
            thinkingLevel={settings.thinkingLevel}
            onSelectThinking={chooseThinking}
            {onToggleFavorite}
            {onReorderFavorite}
          />
        {/if}
      </div>
    </div>

    <button
      type="button"
      class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      aria-label="Dismiss AI account setup"
      title="Dismiss"
      onclick={onDismiss}
    >
      <X size={14} />
    </button>
  </div>
</div>
