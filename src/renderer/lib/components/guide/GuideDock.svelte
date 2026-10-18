<script lang="ts">
  import CioArrowLeft from 'cio-icon/CioArrowLeft.svelte'
  import CioArrowRight from 'cio-icon/CioArrowRight.svelte'
  import CioClose from 'cio-icon/CioClose.svelte'
  import { onMount } from 'svelte'

  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { cubicOut } from 'svelte/easing'
  import { fly } from 'svelte/transition'
  import ShortcutHint from '$lib/components/ui/ShortcutHint.svelte'
  import { COMPOSER_DECISIONS, GUIDE_DOCK_WIDTH_REM } from '$lib/guide/guide-stops'
  import { guideState } from '$lib/guide/guide-state.svelte'
  import { harnessAccountCache } from '$lib/stores/harness-accounts'
  import { providerStore } from '$lib/stores/providers.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { motionDuration, slideWidth } from '$lib/motion'
  import type { ProviderConnectionInfo } from '$shared/types'

  /**
   * The commentary dock: everything a guide says, in a column beside the app,
   * and the one button that takes the step the stop is asking for.
   *
   * It is a column rather than a card because a guide is about the app it points
   * at, and a card would cover the very thing being explained. Nothing here is
   * positioned over the interface: the app reflows beside it and keeps working
   * while the guide talks.
   */

  const guide = $derived(guideState.guide)
  const stop = $derived(guideState.stop)
  const stopIndex = $derived(guideState.stopIndex)
  const stopCount = $derived(guideState.stopCount)
  /** The step this stop asks the app to take, when it asks for one. */
  const action = $derived(stop?.action ?? null)
  /** The other way to take this step, for a user the primary does not fit. */
  const alternative = $derived(stop?.alternative ?? null)

  /**
   * The harnesses this app knows, Pi first.
   *
   * Pi is the agent that ships with the app, so it leads the list as the one a
   * first run can start with, and everything else follows in the order the app
   * itself discovers them. Every tile is a door: one this machine already runs
   * opens its accounts, one it does not have yet opens the page that installs it.
   */
  const harnesses = $derived(
    [...providerStore.providers].sort((left, right) =>
      left.id === 'pi' ? -1 : right.id === 'pi' ? 1 : 0
    )
  )

  /** One line of state under a harness's name, in the same words the settings
   *  page uses, so the two never disagree about what this machine has. */
  function harnessState(provider: ProviderConnectionInfo): string {
    if (provider.status === 'checking') return 'Checking'
    if (provider.status === 'available' && provider.integration === 'ready') return 'Ready'
    if (provider.status === 'available') return 'Detected'
    if (provider.status === 'error') return 'Needs attention'
    return 'Not installed'
  }

  /**
   * What Pi's own tile says.
   *
   * Pi ships inside CodeInOven, so it is never missing: `Installed` means this
   * machine also has a copy of its own, and `Bundled` means the copy in the app
   * is the one that will run. Either way its tile opens Pi's provider accounts,
   * because a bundled agent can take credentials immediately.
   */
  function piState(provider: ProviderConnectionInfo): string {
    return provider.status === 'available' ? 'Installed' : 'Bundled'
  }

  /**
   * How many accounts this harness already answers with, from the same registry
   * the model picker and the accounts page read. The count is what makes the
   * badge worth reading: one connected account is a harness in use, and several
   * is a harness the user has already made a decision about.
   */
  function connectedCountFor(harnessId: string): number {
    return harnessAccountCache.cached(harnessId)?.length ?? 0
  }

  /**
   * True while a gated stop is holding the guide at this step.
   *
   * A gate is the one thing a first run cannot walk past: the agent step stays
   * put until this machine has an agent it can actually run, so its Next is
   * disabled, its keyboard chord does nothing (`guideState.next` refuses the
   * same), and the dots that would jump over it are disabled too. A user who
   * already has an agent arrives with the gate open.
   */
  const heldByGate = $derived(stop?.gate !== undefined && !guideState.stepReady)

  /** Index of the guide's gated stop, or -1 when no stop is gated. */
  const gateIndex = $derived(
    guide ? guide.stops.findIndex((candidate) => candidate.gate !== undefined) : -1
  )

  /** A dot past the gate is a skip, so it is disabled until the gate is open. */
  function dotBlocked(dot: number): boolean {
    return heldByGate && gateIndex >= 0 && dot > gateIndex
  }

  /** What the step button in the footer promises to do, for its tooltip. */
  function nextLabel(): string {
    if (heldByGate) return 'Connect or install an agent to continue'
    if (guideState.onLastStop) return 'Finish the guide'
    return action ? 'Skip this step' : 'Next stop'
  }

  let root = $state<HTMLElement | undefined>(undefined)

  const padded = (value: number): string => String(value).padStart(2, '0')

  /**
   * The guide owns three chords, registered in the keymap file so any of them
   * can be rebound. The listener runs in the capture phase while the dock is
   * mounted, which is exactly while a guide is on screen, so Escape leaves the
   * guide instead of reaching whatever else in the app also listens for it.
   */
  onMount(() => {
    root?.focus({ preventScroll: true })
    // The accounts a harness already answers with, so the harness list can say
    // which ones are in use before the settings page is ever opened.
    void harnessAccountCache.warm().catch(() => [])
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      if (keymapState.matches('guide-next', event)) {
        event.preventDefault()
        event.stopPropagation()
        guideState.next()
        return
      }
      if (keymapState.matches('guide-back', event)) {
        event.preventDefault()
        event.stopPropagation()
        guideState.back()
        return
      }
      if (keymapState.matches('guide-close', event) || closesGuide(event)) {
        event.preventDefault()
        event.stopPropagation()
        guideState.close()
      }
    }

    /** Escape closes a guide, the same gesture that closes the app's other
     *  transient surfaces, unless the press is already aimed at a dialog. */
    function closesGuide(event: KeyboardEvent): boolean {
      if (!keymapState.matches('ui-close-modal', event)) return false
      const target = event.target
      return !(target instanceof Element) || target.closest('[role="dialog"]') === null
    }
    window.addEventListener('keydown', onKeydown, { capture: true })
    return () => window.removeEventListener('keydown', onKeydown, { capture: true })
  })
</script>

{#if guide && stop}
  <!-- The track animates its width, so the app beside it reflows instead of
       being covered, and the content is pinned to the far edge so it does not
       reflow while the track moves. -->
  <div
    class="h-full shrink-0"
    style:width="{GUIDE_DOCK_WIDTH_REM}rem"
    in:slideWidth={{ duration: motionDuration(200), easing: cubicOut }}
    out:slideWidth={{ duration: motionDuration(160), easing: cubicOut }}
  >
    <aside
      bind:this={root}
      class="flex h-full flex-col overflow-hidden border-l border-border bg-surface outline-none"
      style:width="{GUIDE_DOCK_WIDTH_REM}rem"
      aria-label={guide.name}
      tabindex="-1"
      data-guide-dock
    >
      <div class="flex shrink-0 items-center gap-2 border-b border-border px-3.5 py-3">
        <span class="text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-dimmed">
          {guide.name}
        </span>
        <span class="h-px min-w-4 flex-1 bg-border"></span>
        <span class="text-[0.5625rem] tracking-[0.08em] text-dimmed tabular-nums">
          {padded(stopIndex + 1)} / {padded(stopCount)}
        </span>
        <span
          class="shrink-0 border border-border bg-elevated px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-[0.16em] text-muted"
        >
          {stop.tag}
        </span>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-3.5 py-3.5" aria-live="polite">
        <!-- The copy arrives with a short move of its own, so a stop that changes
             under the reader is seen to change rather than silently replaced. -->
        {#key stopIndex}
          <div in:fly={{ y: 6, duration: motionDuration(180), easing: cubicOut }}>
            <p class="text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-accent">
              {stop.eyebrow}
            </p>
            <h2
              class="mt-2 text-[0.9375rem] font-semibold leading-[1.35] tracking-tight text-foreground"
            >
              {stop.title}
            </h2>
            <p class="mt-1.5 text-[0.8125rem] leading-relaxed text-muted">{stop.description}</p>

            <div class="mt-3.5 border-t border-border pt-3">
              {#if stop.treatment === 'harnesses'}
                <span
                  class="text-[0.5625rem] font-semibold uppercase tracking-[0.16em] text-dimmed"
                >
                  The agents
                </span>
                {#if harnesses.length === 0}
                  <p class="mt-2 text-[0.6875rem] text-muted">
                    Looking for the agents on this machine.
                  </p>
                {:else}
                  <div class="mt-2 flex flex-col gap-1">
                    {#each harnesses as harness (harness.id)}
                      {@const ready = providerStore.canAddProvider(harness)}
                      {@const openable = harness.id === 'pi' || ready}
                      {@const busy = harness.status === 'checking' && !openable}
                      {@const connected = connectedCountFor(harness.id)}
                      <button
                        type="button"
                        class="flex items-center gap-2 border px-2 py-1.5 text-left transition-colors disabled:opacity-60 {harness.id ===
                        'pi'
                          ? 'border-accent bg-surface'
                          : 'border-border bg-elevated'} {busy
                          ? ''
                          : 'hover:border-border-strong hover:bg-raised'}"
                        title={busy
                          ? `${harness.name} is being checked`
                          : openable
                            ? `Manage ${harness.name}’s provider accounts`
                            : `Open ${harness.name} in settings to install it`}
                        aria-label={busy
                          ? `${harness.name}: checking`
                          : openable
                            ? `${harness.name}: manage provider accounts`
                            : `${harness.name}: open in settings to install`}
                        disabled={busy}
                        onclick={() =>
                          guideState.requestChoice({ kind: 'open-harness', harnessId: harness.id })}
                      >
                        <AgentIcon agentId={harness.id} label={harness.name} size={20} />
                        <span class="min-w-0 flex-1">
                          <span class="block truncate text-[0.75rem] text-foreground"
                            >{harness.name}</span
                          >
                          <span class="block truncate text-[0.625rem] text-dimmed">
                            {harness.id === 'pi' ? 'Ships with CodeInOven' : harnessState(harness)}
                          </span>
                        </span>
                        {#if connected > 0}
                          <!-- Already answering with accounts: the badge says how
                               many, which is the one thing the settings page
                               would have told the user. -->
                          <span
                            class="shrink-0 border border-success/30 bg-success/10 px-1 py-0.5 text-[0.5625rem] uppercase tracking-[0.12em] text-success"
                          >
                            Connected · {connected}
                          </span>
                        {:else}
                          <span
                            class="shrink-0 border border-border px-1 py-0.5 text-[0.5625rem] uppercase tracking-[0.12em] {ready
                              ? 'text-success'
                              : 'text-dimmed'}"
                          >
                            {harness.id === 'pi' ? piState(harness) : harnessState(harness)}
                          </span>
                        {/if}
                      </button>
                    {/each}
                  </div>
                {/if}
              {:else if stop.treatment === 'actions'}
                <span
                  class="text-[0.5625rem] font-semibold uppercase tracking-[0.16em] text-dimmed"
                >
                  Start another
                </span>
                <div class="mt-2 flex flex-col gap-1">
                  {#each stop.choices ?? [] as choice (choice.label)}
                    <button
                      type="button"
                      class="flex items-center gap-2 border border-border bg-elevated px-2 py-1.5 text-left transition-colors hover:border-border-strong hover:bg-raised"
                      title={choice.label}
                      onclick={() => guideState.requestChoice(choice.run)}
                    >
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-[0.75rem] text-foreground"
                          >{choice.label}</span
                        >
                        <span class="block text-[0.625rem] leading-snug text-dimmed"
                          >{choice.detail}</span
                        >
                      </span>
                      <CioArrowRight size={12} />
                    </button>
                  {/each}
                </div>
              {:else if stop.treatment === 'anatomy'}
                <span
                  class="text-[0.5625rem] font-semibold uppercase tracking-[0.16em] text-dimmed"
                >
                  The composer
                </span>
                <div class="mt-2 flex flex-col gap-0.5">
                  {#each COMPOSER_DECISIONS as decision (decision.position)}
                    <div
                      class="flex items-center gap-2 border border-border bg-elevated px-1.5 py-1"
                    >
                      <span
                        class="flex h-3.5 w-3.5 shrink-0 items-center justify-center border border-accent bg-surface text-[0.5625rem] tabular-nums text-foreground"
                      >
                        {decision.position}
                      </span>
                      <span class="text-[0.6875rem] text-muted">{decision.name}</span>
                    </div>
                  {/each}
                </div>
                <p class="mt-2 text-[0.625rem] leading-relaxed text-dimmed">
                  Four decisions, all taken before the first word is sent.
                </p>
              {:else}
                <span
                  class="text-[0.5625rem] font-semibold uppercase tracking-[0.16em] text-dimmed"
                >
                  Locator
                </span>
                <div class="mt-2 flex flex-wrap items-center gap-2">
                  {#each stop.path as part, index (part)}
                    {#if index > 0}
                      <span class="h-px w-2 bg-border-strong"></span>
                    {/if}
                    <span
                      class="border px-1.5 py-0.5 text-[0.625rem] {index === 0
                        ? 'border-accent bg-surface text-foreground'
                        : 'border-border bg-elevated text-muted'}"
                    >
                      {part}
                    </span>
                  {/each}
                </div>
                <p class="mt-2 text-[0.625rem] leading-relaxed text-dimmed">
                  Where the lit element lives, from the rail inward.
                </p>
              {/if}
            </div>

            {#if stop.keys?.length}
              <div class="mt-3.5 flex flex-col gap-1">
                {#each stop.keys as key (key.action)}
                  <div class="flex items-center gap-2">
                    <span class="min-w-0 flex-1 truncate text-[0.6875rem] text-muted"
                      >{key.label}</span
                    >
                    <ShortcutHint keys={keymapState.keysFor(key.action)} />
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/key}
      </div>

      <div class="shrink-0 border-t border-border px-3.5 pt-2.5 pb-3.5">
        <div class="flex flex-wrap gap-0.5" role="group" aria-label="Guided stops">
          {#each Array.from({ length: stopCount }, (_, dot) => dot) as dot (dot)}
            <button
              type="button"
              class="h-1.5 border transition-[width,background-color,border-color] duration-150 disabled:opacity-40 {dot ===
              stopIndex
                ? 'w-4.5 border-accent bg-accent'
                : 'w-1.5 border-border bg-raised hover:border-border-strong'}"
              aria-label={`Stop ${dot + 1} of ${stopCount}`}
              title={dotBlocked(dot)
                ? 'Connect or install an agent before walking past this step'
                : `Stop ${dot + 1} of ${stopCount}`}
              disabled={dotBlocked(dot)}
              onclick={() => guideState.goTo(dot)}
            ></button>
          {/each}
        </div>

        {#if action}
          <!-- The step the stop asks for, with the other way to take it beside
               it: a stop asks for one thing and offers one alternative, never a
               menu. The alternative stays quieter and to the left. -->
          <div class="mt-2.5 flex items-center justify-end gap-1.5 border-t border-border pt-2.5">
            {#if alternative}
              <button
                type="button"
                class="flex h-8 items-center gap-1.5 border border-border px-2 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
                title={alternative.label}
                onclick={() => guideState.requestAlternative()}
              >
                {alternative.label}
              </button>
            {/if}
            <button
              type="button"
              class="flex h-8 items-center gap-1.5 border border-primary bg-primary px-2.5 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover"
              title={action.label}
              onclick={() => guideState.requestAction()}
            >
              {action.label}
              <CioArrowRight size={12} />
            </button>
          </div>
        {/if}

        <div class="mt-2.5 flex items-center gap-1.5 border-t border-border pt-2.5">
          <button
            type="button"
            class="flex h-8 items-center gap-1.5 px-2 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
            title="Close the guide"
            aria-label="Close the guide"
            onclick={() => guideState.close()}
          >
            <CioClose size={12} />
            Close
          </button>
          <span class="flex-1"></span>
          <!-- Back always sits left of the step button, and the step button
               is always the same slot: rightmost. A stop with its own action
               row above keeps this one quieter, because the labelled step is
               the loud one, and calls it Skip, because it does not do the
               step. A gated stop has no action and only one way on: its Next,
               which stays disabled until the gate is open. The order never
               changes between stops. -->
          <button
            type="button"
            class="flex h-8 items-center gap-1.5 border border-border px-2 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
            title="Previous stop"
            aria-label="Previous stop"
            disabled={stopIndex === 0}
            onclick={() => guideState.back()}
          >
            <CioArrowLeft size={12} />
            Back
          </button>
          <button
            type="button"
            class="flex h-8 items-center gap-1.5 px-2.5 text-[0.6875rem] transition-colors disabled:opacity-40 {action
              ? 'border border-border text-muted hover:bg-elevated hover:text-foreground'
              : 'border border-primary bg-primary font-medium text-on-primary hover:bg-primary-hover disabled:hover:bg-primary'}"
            title={nextLabel()}
            disabled={heldByGate}
            onclick={() => guideState.next()}
          >
            {guideState.onLastStop ? 'Done' : action ? 'Skip' : 'Next'}
            {#if !guideState.onLastStop}<CioArrowRight size={12} />{/if}
          </button>
        </div>
      </div>
    </aside>
  </div>
{/if}
