<script lang="ts">
  import {
    AudioLines,
    ChevronRight,
    Clapperboard,
    Maximize2,
    Palette,
    PencilRuler,
    Settings2,
    Sparkles,
    Users
  } from '@lucide/svelte'
  import Modal from '../ui/Modal.svelte'
  import type { ExpertSummary } from '$shared/experts'
  import type { ThreadExpertState } from '$shared/ipc-contract'
  import type { DesignAssignmentOutput } from '$shared/types'

  /**
   * The card that asks about a session's experts before its first message goes.
   *
   * A design or video session is staffed by models the user chose in Settings,
   * Design: the copy, the pictures, the clips, the voice. The model running the
   * session is often not the one they would pick for those, which is the whole
   * point of staffing them, so the app asks once per session whether the agent
   * may hand that work over, and remembers the answer.
   *
   * The card is deliberately a sibling of the vision gate rather than a modal: it
   * arrives on a send the user just made, and it has to be answerable without
   * losing the draft behind it. The same list opens full screen for reading, where
   * the standing instruction on each expert is shown in full.
   */

  interface Props {
    /** The thread's experts, its recorded answer, and the session it is in. */
    expertState: ThreadExpertState
    /** Which session this send belongs to, which chooses the card's words. */
    session: 'design' | 'video'
    /** Human label for an expert's model, resolved from the provider catalog. */
    modelLabel: (expert: ExpertSummary) => string
    /** True while the harness is being started for the send that follows. */
    warming?: boolean
    onUse: () => void
    onDisable: () => void
    onNeverAsk: () => void
    onOpenSettings: () => void
  }

  let {
    expertState,
    session,
    modelLabel,
    warming = false,
    onUse,
    onDisable,
    onNeverAsk,
    onOpenSettings
  }: Props = $props()

  let fullscreen = $state(false)

  /** The craft's own icon, so a row reads as work rather than as a file type. */
  const CRAFT_ICON: Record<DesignAssignmentOutput, typeof PencilRuler> = {
    text: PencilRuler,
    image: Palette,
    video: Clapperboard,
    audio: AudioLines
  }

  const owners = $derived(expertState.experts.length)
  const countLabel = $derived(owners === 1 ? '1 expert' : `${owners} experts`)
  const sessionLabel = $derived(session === 'video' ? 'video session' : 'design session')

  /**
   * Focus the primary action when the card appears, because the card has no field
   * to type in and the user's next act is to answer it.
   */
  function focusOnMount(node: HTMLButtonElement): void {
    node.focus()
  }
</script>

<div
  class="mx-3 mt-2.5 rounded-xl border border-accent/30 bg-accent/5 p-4"
  role="dialog"
  aria-labelledby="expert-card-title"
>
  <div class="flex items-start gap-2.5">
    <div class="mt-0.5 shrink-0 rounded-lg bg-accent/10 p-1.5 text-accent">
      <Sparkles size={15} />
    </div>
    <div class="min-w-0 flex-1">
      <div class="flex items-start justify-between gap-2">
        <p id="expert-card-title" class="text-sm font-semibold text-foreground">
          Your experts can do this work
        </p>
        <button
          type="button"
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          title="Read every expert and their standing instruction"
          aria-label="Open the expert list full screen"
          onclick={() => (fullscreen = true)}
        >
          <Maximize2 size={13} />
        </button>
      </div>
      <p class="mt-1 text-xs leading-relaxed text-muted">
        {countLabel} are staffed for this {sessionLabel}. Your agent hands them the craft work
        instead of improvising it, so the words and the assets come from the models you chose.
      </p>
    </div>
  </div>

  <div class="mt-3 max-h-56 overflow-y-auto rounded-lg border border-border bg-surface">
    {#each expertState.experts as expert (expert.id)}
      {@const Icon = CRAFT_ICON[expert.produces]}
      <div class="flex items-center gap-2.5 border-b border-border px-2.5 py-2 last:border-b-0">
        <span class="shrink-0 text-dimmed">
          <Icon size={14} />
        </span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-xs font-medium text-foreground">{expert.label}</p>
          <p class="truncate text-xs text-dimmed">{modelLabel(expert)}</p>
        </div>
        <span
          class="shrink-0 rounded-md bg-elevated px-1.5 py-0.5 text-xs text-muted"
          title={expert.craftDescription}
        >
          {expert.craftLabel}
        </span>
      </div>
    {/each}
  </div>

  <div class="mt-3 flex flex-wrap items-center gap-2">
    <button
      type="button"
      class="flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover"
      title="Let this session delegate its craft work to every expert you staffed"
      onclick={onUse}
      {@attach focusOnMount}
    >
      <Users size={13} /> Use all experts
    </button>
    <button
      type="button"
      class="flex h-9 items-center gap-1.5 rounded-lg border bg-elevated px-3 text-xs font-medium transition-colors hover:bg-overlay"
      title="Turn the experts off for this thread and send now. They can be turned back on from the design board."
      onclick={onDisable}
    >
      Disable for this thread
    </button>
    <button
      type="button"
      class="flex h-9 items-center rounded-lg px-2.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
      title="Turn the experts off for this thread and stop asking in it"
      onclick={onNeverAsk}
    >
      Don't use experts
    </button>
    {#if warming}
      <span class="ml-auto flex items-center gap-1.5 text-xs text-dimmed" role="status">
        Starting your harness
      </span>
    {/if}
  </div>

  <div class="mt-2.5 flex items-center justify-between gap-2">
    <p class="text-xs text-dimmed">Settings, Design decides who does each craft.</p>
    <button
      type="button"
      class="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
      title="Open Settings, Design to change who does each craft"
      onclick={onOpenSettings}
    >
      <Settings2 size={12} /> Manage experts <ChevronRight size={12} />
    </button>
  </div>
</div>

{#if fullscreen}
  <!--
    The reading surface: the same experts with the standing instruction each one
    carries, which is the part that does not fit in a composer row and is exactly
    the part a user wants to check before letting a session delegate to it.
  -->
  <Modal
    open
    title="Your experts"
    description={`The models you staffed for the craft work a ${sessionLabel} needs.`}
    size="full"
    placement="fullscreen"
    onClose={() => (fullscreen = false)}
  >
    {#snippet footer()}
      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover"
          title="Let this session delegate its craft work to every expert you staffed"
          onclick={() => {
            fullscreen = false
            onUse()
          }}
        >
          <Users size={13} /> Use all experts
        </button>
        <button
          type="button"
          class="flex h-9 items-center gap-1.5 rounded-lg border bg-elevated px-3 text-xs font-medium transition-colors hover:bg-overlay"
          title="Turn the experts off for this thread and send now. They can be turned back on from the design board."
          onclick={() => {
            fullscreen = false
            onDisable()
          }}
        >
          Disable for this thread
        </button>
        <button
          type="button"
          class="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Open Settings, Design to change who does each craft"
          onclick={onOpenSettings}
        >
          <Settings2 size={12} /> Manage experts
        </button>
      </div>
    {/snippet}

    <div class="mx-auto flex w-full max-w-3xl flex-col gap-3 p-6">
      <p class="text-sm text-muted">
        {countLabel} are staffed for this {sessionLabel}. Your agent hands them the craft work
        instead of improvising it.
      </p>
      {#each expertState.experts as expert (expert.id)}
        {@const Icon = CRAFT_ICON[expert.produces]}
        <section class="rounded-xl border border-border bg-surface p-4">
          <div class="flex items-start gap-3">
            <span class="mt-0.5 shrink-0 rounded-lg bg-elevated p-2 text-accent">
              <Icon size={16} />
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <h3 class="text-sm font-semibold text-foreground">{expert.label}</h3>
                <span class="rounded-md bg-elevated px-1.5 py-0.5 text-xs text-muted">
                  {expert.craftLabel}
                </span>
              </div>
              <p class="mt-1 text-xs text-muted">{expert.craftDescription}</p>
              <p class="mt-2 text-xs text-dimmed">
                <span class="text-muted">Model:</span>
                {modelLabel(expert)}
              </p>
              <p class="mt-1 text-xs text-dimmed">
                <span class="text-muted">Handle the agent names:</span>
                {expert.id}
              </p>
              {#if expert.instructions}
                <div class="mt-3 rounded-lg border border-border bg-app p-3">
                  <p class="text-xs font-medium text-muted">
                    Standing instruction, sent with every call
                  </p>
                  <p class="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-foreground">
                    {expert.instructions}
                  </p>
                </div>
              {:else}
                <p class="mt-3 text-xs text-dimmed">
                  No standing instruction: the request carries everything.
                </p>
              {/if}
            </div>
          </div>
        </section>
      {/each}
    </div>
  </Modal>
{/if}
