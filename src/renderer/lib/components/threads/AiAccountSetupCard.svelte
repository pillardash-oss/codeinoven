<script lang="ts">
  import CioPlug from '@codeinoven/icons/CioPlug.svelte'
  import CioSparkles from '@codeinoven/icons/CioSparkles.svelte'
  import { slide } from 'svelte/transition'
  import { harnessCatalogs, harnessHasProvider } from '$lib/ai-account'
  import { withModelSelection } from '../chats/chat-composer-settings'
  import { APP_NAME } from '$shared/brand'
  import { threadCardFold } from '$lib/stores/thread-card-fold.svelte'
  import type { ProviderCatalog, ThinkingLevel, ThreadSettings } from '$shared/types'
  import CardButton from '../shared/CardButton.svelte'
  import CardCloseButton from '../shared/CardCloseButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import CardTag from '../shared/CardTag.svelte'
  import { dismissSlide, foldSlide } from '../shared/card-motion'
  import ModelPicker from '../shared/ModelPicker.svelte'

  interface Props {
    /** Display name of the harness this thread runs on, e.g. Pi. */
    harnessName: string
    /** Catalogs available to this project. */
    providers: ProviderCatalog[]
    settings: ThreadSettings
    projectId: string
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
    /** Another card sits directly above this one, so its top rule is the broken
     *  line that separates two stacked surfaces. */
    stackedAbove?: boolean
    /** The surface below carries the join, so this card drops its bottom rule. */
    joinsBelow?: boolean
    /** Thread the card belongs to, so its fold state is remembered per thread. */
    threadId?: string
  }

  let {
    harnessName,
    providers,
    settings,
    projectId,
    favoriteModels = [],
    recentModels = [],
    onRemoveRecent,
    onToggleFavorite,
    onReorderFavorite,
    onModelChange,
    onConnect,
    onDismiss,
    stackedAbove = false,
    joinsBelow = false,
    threadId
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
  /** The fold control writes a per-thread preference, so a card the reader folded
   *  stays folded when the thread is reopened. */
  let localFolded = $state(false)
  const foldState = {
    get folded(): boolean {
      return threadId === undefined ? localFolded : threadCardFold.isFolded(threadId, 'account')
    },
    set folded(value: boolean) {
      if (threadId === undefined) localFolded = value
      else threadCardFold.setFolded(threadId, 'account', value)
    }
  }

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

  function chooseRuntime(runtime: import('$shared/types').ModelRuntimeSettings): void {
    onModelChange({ ...settings, ...runtime })
  }
</script>

<div out:slide={dismissSlide()} role="status" aria-live="polite">
  <CardFrame placement="replace" label="AI account setup" {stackedAbove} {joinsBelow}>
    <CardHead
      icon={connected ? CioSparkles : CioPlug}
      title={connected ? 'Choose the model for this thread' : 'Connect your AI account'}
      chip={connected ? { text: 'Ready' } : { text: 'Waiting', tone: 'paused' }}
      bind:folded={foldState.folded}
      foldLabel="AI account setup"
    >
      {#snippet meta()}
        <CardTag text={harnessName} />
      {/snippet}

      <!-- Dismissal is a close, not an answer: it ends the card without choosing
           anything, so it lives in the head. The foot then carries only an action
           the card is actually asking for, and the connected state has none. -->
      {#snippet controls()}
        <CardCloseButton title="Dismiss AI account setup" onclick={onDismiss} />
      {/snippet}
    </CardHead>

    {#if !foldState.folded}
      <div
        transition:slide={foldSlide()}
        class="flex flex-col gap-2 px-3 py-2.5 text-xs leading-relaxed text-muted"
      >
        <p>
          {#if !connected}
            {APP_NAME} works through the AI accounts you already have. Connect OpenAI, Anthropic, Google,
            or another provider, then pick a model and send your message.
          {:else if connectedNames}
            {connectedNames} connected. Pick the model this thread should use.
          {:else}
            Pick the model this thread should use.
          {/if}
        </p>

        {#if !connected}
          <p class="text-[0.6875rem] text-dimmed">
            Signing in happens inside {APP_NAME}. Credentials are stored by {APP_NAME} in
            {harnessName}'s own credential file on this machine.
          </p>
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
            runtimeSettings={settings}
            onSelectThinking={chooseThinking}
            onSelectRuntime={chooseRuntime}
            {onToggleFavorite}
            {onReorderFavorite}
          />
        {/if}
      </div>
    {/if}

    {#if !foldState.folded && !connected}
      <CardFoot>
        {#snippet right()}
          <CardButton
            label="Connect Your AI Account"
            title="Connect your AI account"
            icon={CioPlug}
            variant="primary"
            onclick={onConnect}
          />
        {/snippet}
      </CardFoot>
    {/if}
  </CardFrame>
</div>
