<script lang="ts">
  import { FileText, Lightbulb, Loader2, Sparkles, X } from '@lucide/svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import type { ProviderCatalog, ThreadSettings, ThinkingLevel } from '$shared/types'

  interface Props {
    busy?: boolean
    retryChoice?: 'brainstorm' | 'spec'
    providers?: ProviderCatalog[]
    projectId?: string | null
    settings?: ThreadSettings
    favoriteModels?: string[]
    recentModels?: string[]
    onStartBrainstorm: () => void | Promise<void>
    onJumpToSpec: () => void | Promise<void>
    onModelChange?: (settings: ThreadSettings) => void
    onCancel?: () => void
    /** Dismiss the card and revert an accidental engineering-mode send. */
    onClose?: () => void | Promise<void>
    onToggleFavorite?: (providerId: string, modelId: string, harnessId: string) => void
    /** Removes one model from the recently-used history; shows the "x" on recent rows. */
    onRemoveRecent?: (modelKey: string) => void
    onReorderFavorite?: (
      draggedKey: string,
      targetKey: string,
      position: 'before' | 'after'
    ) => void
  }

  let {
    busy = false,
    retryChoice,
    providers = [],
    projectId = null,
    settings,
    favoriteModels = [],
    recentModels = [],
    onStartBrainstorm,
    onJumpToSpec,
    onModelChange,
    onCancel,
    onClose,
    onToggleFavorite,
    onRemoveRecent,
    onReorderFavorite
  }: Props = $props()

  function chooseModel(providerId: string, modelId: string, nextHarnessId?: string): void {
    if (!settings) return
    onModelChange?.({
      ...settings,
      harnessId: nextHarnessId ?? settings.harnessId,
      providerId,
      modelId
    })
  }

  function chooseThinking(level: ThinkingLevel): void {
    if (!settings) return
    onModelChange?.({ ...settings, thinkingLevel: level })
  }
</script>

<section
  class="overflow-hidden rounded-xl border bg-surface shadow-sm"
  aria-label="Choose planning path"
>
  <div class="flex items-center gap-2 border-b px-4 py-2.5">
    <Sparkles size={15} class="shrink-0 text-accent" />
    <p class="truncate text-xs font-semibold uppercase tracking-wide text-muted">Plan your work</p>
    {#if onClose}
      <button
        type="button"
        class="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
        title="Close and revert this message to a normal chat draft"
        aria-label="Close and revert this message to a normal chat draft"
        disabled={busy}
        onclick={() => void onClose()}
      >
        <X size={14} />
      </button>
    {/if}
  </div>

  <div class="space-y-1.5 p-4">
    <p class="text-sm font-semibold text-foreground">
      {retryChoice ? 'Planning paused' : 'How do you want to begin?'}
    </p>
    <p class="text-xs leading-relaxed text-muted">
      {retryChoice
        ? 'The saved planning choice is safe. Retry generation without choosing the path again.'
        : 'Work through an evidence-led conversation with the Sr. Engineer, or move directly to a specification.'}
    </p>
  </div>

  {#if retryChoice}
    <div class="flex items-center justify-between gap-2 border-t px-4 py-2.5">
      <button
        class="min-h-8 rounded-lg px-3 py-1.5 text-xs font-semibold text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
        disabled={busy}
        onclick={onCancel}
      >
        Cancel
      </button>
      <div class="flex items-center gap-2">
        {#if settings}
          <ModelPicker
            {providers}
            {projectId}
            harnessId={settings.harnessId}
            providerId={settings.providerId}
            modelId={settings.modelId}
            {favoriteModels}
            {recentModels}
            {onRemoveRecent}
            side="top"
            label="Change"
            variant="action"
            onSelect={chooseModel}
            thinkingLevel={settings.thinkingLevel}
            onSelectThinking={chooseThinking}
            {onToggleFavorite}
            {onReorderFavorite}
          />
        {:else}
          <button
            class="flex min-h-8 items-center gap-1 rounded-lg border bg-elevated px-3 py-1.5 text-xs font-semibold text-muted disabled:opacity-40"
            disabled
            title="Choose a model before retrying"
          >
            Change
          </button>
        {/if}
        <button
          class="flex min-h-8 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-40"
          disabled={busy}
          onclick={retryChoice === 'brainstorm' ? onStartBrainstorm : onJumpToSpec}
        >
          {#if busy}<Loader2 size={13} class="animate-spin" />{/if}
          {retryChoice === 'brainstorm' ? 'Retry brainstorm' : 'Retry specification'}
          {#if retryChoice === 'brainstorm'}
            <Lightbulb size={13} />
          {:else}
            <FileText size={13} />
          {/if}
        </button>
      </div>
    </div>
  {:else}
    <div class="grid gap-2 border-t p-3 sm:grid-cols-2">
      <button
        class="flex min-h-14 items-start gap-2.5 rounded-lg border bg-elevated px-3 py-2.5 text-left transition-colors hover:bg-overlay disabled:opacity-40"
        disabled={busy}
        onclick={onStartBrainstorm}
      >
        <Lightbulb size={15} class="mt-0.5 shrink-0 text-accent" />
        <span class="min-w-0">
          <span class="block text-xs font-semibold text-foreground">Start brainstorm</span>
          <span class="mt-0.5 block text-[11px] leading-relaxed text-muted">
            Research the real context, answer focused questions, and align the direction before the
            spec.
          </span>
        </span>
      </button>
      <button
        class="flex min-h-14 items-start gap-2.5 rounded-lg border bg-elevated px-3 py-2.5 text-left transition-colors hover:bg-overlay disabled:opacity-40"
        disabled={busy}
        onclick={onJumpToSpec}
      >
        <FileText size={15} class="mt-0.5 shrink-0 text-primary" />
        <span class="min-w-0">
          <span class="block text-xs font-semibold text-foreground">Jump into spec</span>
          <span class="mt-0.5 block text-[11px] leading-relaxed text-muted">
            Skip brainstorming and ask the Sr. Engineer to prepare the specification now.
          </span>
        </span>
      </button>
    </div>
  {/if}
</section>
