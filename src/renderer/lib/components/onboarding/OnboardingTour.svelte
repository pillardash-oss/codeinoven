<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { Portal } from 'bits-ui'
  import {
    ArrowLeft,
    ArrowRight,
    Download,
    FolderInput,
    FolderKanban,
    Loader2,
    MessageSquare,
    PanelRight,
    X
  } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { providerStore } from '$lib/stores/providers.svelte'
  import { APP_NAME } from '$shared/brand'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import {
    SETUP_SPOTLIGHT_STEPS,
    VIEW_TOURS,
    viewTourLabel,
    type WorkspaceTourView
  } from './onboarding-tour-steps'

  interface Props {
    /** Which tour is running: the first-run setup sequence, or one content
     *  view's own tour. */
    tour?: 'setup' | WorkspaceTourView
    /**
     * Position inside the running tour. The setup tour numbers its screens
     * (0 welcome, 1-5 the spotlights, 6 the first project, 7+ the first
     * agent); a view tour has no other screens, so it numbers its spotlights
     * from 0.
     */
    step: number
    onStepChange: (step: number) => void
    /** Setup tour only: open the project picker. */
    onChooseProject?: () => void
    /** Setup tour only: leave for the harness list in Settings. */
    onBrowseHarnesses?: () => void
    onFinish: () => void
  }

  interface TargetRect {
    top: number
    left: number
    width: number
    height: number
  }

  let {
    tour = 'setup',
    step,
    onStepChange,
    onChooseProject,
    onBrowseHarnesses,
    onFinish
  }: Props = $props()

  const steps = $derived(tour === 'setup' ? SETUP_SPOTLIGHT_STEPS : VIEW_TOURS[tour].steps)
  const tourLabel = $derived(tour === 'setup' ? 'Getting started tour' : viewTourLabel(tour))
  /** Position inside `steps`: the setup tour spends its first screen on the
   *  welcome card and its last two on project and agent setup. */
  const spotlightIndex = $derived(tour === 'setup' ? step - 1 : step)
  const activeSpotlight = $derived(steps[spotlightIndex])
  const spotlightCount = $derived(steps.length)
  const onLastSpotlight = $derived(spotlightIndex === spotlightCount - 1)
  /** Box root to place the callout from before it has rendered, so a step that
   *  carries key rows is never positioned from a box that is too short. */
  const calloutEstimate = $derived(activeSpotlight?.shortcuts ? 270 : 220)

  let targetRect = $state<TargetRect | null>(null)
  let calloutTop = $state(0)
  let calloutLeft = $state(0)
  let nextButton = $state<HTMLButtonElement | undefined>(undefined)
  let calloutEl = $state<HTMLDivElement | undefined>(undefined)
  let installOpened = $state(false)
  let installBusy = $state(false)
  let installError = $state('')

  const pi = $derived(providerStore.providers.find((provider) => provider.id === 'pi'))
  const piReady = $derived(pi?.status === 'available' && pi.integration === 'ready')
  const piChecking = $derived(pi?.status === 'checking')
  const piBundled = $derived(pi?.executionTarget?.kind === 'bundled')

  function measureTarget(): void {
    if (!activeSpotlight) return
    const element = document.querySelector<HTMLElement>(activeSpotlight.selector)
    if (!element || !element.checkVisibility()) {
      targetRect = null
      calloutTop = Math.max(24, window.innerHeight / 2 - 150)
      calloutLeft = Math.max(24, window.innerWidth / 2 - 170)
      return
    }

    const bounds = element.getBoundingClientRect()
    const padding = 8
    targetRect = {
      top: Math.max(8, bounds.top - padding),
      left: Math.max(8, bounds.left - padding),
      width: Math.min(window.innerWidth - 16, bounds.width + padding * 2),
      height: Math.min(window.innerHeight - 16, bounds.height + padding * 2)
    }

    const cardWidth = 340
    const cardHeight = calloutEl?.offsetHeight ?? calloutEstimate
    const gap = 16
    const below = targetRect.top + targetRect.height + gap
    const above = targetRect.top - cardHeight - gap
    calloutTop =
      below + cardHeight <= window.innerHeight - 16
        ? below
        : above >= 16
          ? above
          : Math.max(16, (window.innerHeight - cardHeight) / 2)
    calloutLeft = Math.min(
      Math.max(16, targetRect.left),
      Math.max(16, window.innerWidth - cardWidth - 16)
    )
  }

  /** Re-position once the callout has rendered   the initial placement uses a
   *  height estimate, the real card can be taller and must not overflow. */
  $effect(() => {
    if (!activeSpotlight) return
    void tick().then(() => {
      if (calloutEl && Math.abs(calloutEl.offsetHeight - calloutEstimate) > 1) {
        measureTarget()
      }
    })
  })

  function nextStep(): void {
    // A view tour is only its spotlights, so the last one finishes the tour;
    // the setup tour continues into the project and agent screens.
    if (tour !== 'setup') {
      if (onLastSpotlight) onFinish()
      else onStepChange(step + 1)
      return
    }
    onStepChange(step < 5 ? step + 1 : 6)
  }

  function previousStep(): void {
    if (tour !== 'setup' && step === 0) return
    onStepChange(Math.max(0, step - 1))
  }

  async function openPiInstall(): Promise<void> {
    installBusy = true
    installError = ''
    try {
      const info = await invoke('harnessInstall:getInfo', 'pi')
      await openInBrowser(info.pageUrl)
      installOpened = true
    } catch (error) {
      installError =
        error instanceof Error ? error.message : 'The Pi install page could not be opened.'
    } finally {
      installBusy = false
    }
  }

  async function checkPi(): Promise<void> {
    installError = ''
    await providerStore.checkOne('pi')
  }

  onMount(() => {
    void providerStore.init()
    if (!activeSpotlight) return
    const frame = window.requestAnimationFrame(() => {
      measureTarget()
      void tick().then(() => nextButton?.focus({ preventScroll: true }))
    })
    return () => window.cancelAnimationFrame(frame)
  })
</script>

<svelte:window
  onresize={measureTarget}
  onkeydown={(event: KeyboardEvent) => {
    if (keymapState.matches('ui-close-modal', event)) onFinish()
  }}
/>

{#if tour === 'setup' && step === 0}
  <Modal open title={`Welcome to ${APP_NAME}`} onClose={onFinish} size="lg" closeOnBackdrop={false}>
    <div class="space-y-6">
      <div class="flex items-start gap-4">
        <div>
          <p class="mt-1 text-sm leading-relaxed text-muted">
            This short tour shows where projects, conversations, tools, and notifications live. Then
            you can add a folder and connect your first coding agent.
          </p>
        </div>
      </div>

      <div class="grid gap-2 sm:grid-cols-3">
        <div class="rounded-xl border bg-elevated p-3">
          <FolderKanban size={17} class="text-primary" />
          <p class="mt-2 text-sm font-medium">Import your work</p>
          <p class="mt-1 text-xs leading-relaxed text-dimmed">
            Start with a folder already on your computer.
          </p>
        </div>
        <div class="rounded-xl border bg-elevated p-3">
          <MessageSquare size={17} class="text-primary" />
          <p class="mt-2 text-sm font-medium">Prompt the agent</p>
          <p class="mt-1 text-xs leading-relaxed text-dimmed">
            Describe a task and review what the agent does.
          </p>
        </div>
        <div class="rounded-xl border bg-elevated p-3">
          <PanelRight size={17} class="text-primary" />
          <p class="mt-2 text-sm font-medium">Follow the details</p>
          <p class="mt-1 text-xs leading-relaxed text-dimmed">
            Open files, Git, terminals, context, and alerts on the right.
          </p>
        </div>
      </div>

      <div class="flex items-center justify-between border-t pt-4">
        <button
          type="button"
          class="h-9 rounded-lg px-3 text-sm text-muted transition-colors hover:bg-elevated hover:text-foreground"
          onclick={onFinish}
        >
          Skip setup
        </button>
        <button
          type="button"
          class="flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
          data-modal-primary
          onclick={() => onStepChange(1)}
        >
          Show me around <ArrowRight size={15} />
        </button>
      </div>
    </div>
  </Modal>
{:else if activeSpotlight}
  <Portal>
    <div class="fixed inset-0 z-100" aria-live="polite">
      {#if targetRect}
        <div
          class="fixed left-0 right-0 top-0 bg-overlay/80"
          style:height={`${targetRect.top}px`}
        ></div>
        <div
          class="fixed left-0 bg-overlay/80"
          style:top={`${targetRect.top}px`}
          style:width={`${targetRect.left}px`}
          style:height={`${targetRect.height}px`}
        ></div>
        <div
          class="fixed right-0 bg-overlay/80"
          style:top={`${targetRect.top}px`}
          style:left={`${targetRect.left + targetRect.width}px`}
          style:height={`${targetRect.height}px`}
        ></div>
        <div
          class="fixed bottom-0 left-0 right-0 bg-overlay/80"
          style:top={`${targetRect.top + targetRect.height}px`}
        ></div>
        <div
          class="pointer-events-none fixed rounded-xl ring-2 ring-primary ring-offset-2 ring-offset-app"
          style:top={`${targetRect.top}px`}
          style:left={`${targetRect.left}px`}
          style:width={`${targetRect.width}px`}
          style:height={`${targetRect.height}px`}
        ></div>
      {:else}
        <div class="fixed inset-0 bg-overlay/80"></div>
      {/if}

      <div
        bind:this={calloutEl}
        class="fixed max-h-[calc(100vh-2rem)] w-[340px] overflow-y-auto rounded-2xl border bg-surface p-5 shadow-xl"
        style:top={`${calloutTop}px`}
        style:left={`${calloutLeft}px`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-spotlight-title"
      >
        <div class="flex items-start justify-between gap-4">
          <div>
            <p class="text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-primary">
              {activeSpotlight.eyebrow}
            </p>
            <h2 id="onboarding-spotlight-title" class="mt-1 text-base font-semibold">
              {activeSpotlight.title}
            </h2>
          </div>
          <button
            type="button"
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
            title={tour === 'setup' ? 'Skip setup' : 'Close tour'}
            aria-label={tour === 'setup' ? 'Skip setup' : 'Close tour'}
            onclick={onFinish}
          >
            <X size={15} />
          </button>
        </div>
        <p class="mt-2 text-sm leading-relaxed text-muted">{activeSpotlight.description}</p>

        {#if activeSpotlight.shortcuts}
          <div class="mt-4 grid gap-2">
            {#each activeSpotlight.shortcuts as shortcut (shortcut.label)}
              <div
                class="flex items-center justify-between rounded-lg border bg-elevated px-3 py-2"
              >
                <span class="text-xs text-muted">{shortcut.label}</span>
                <kbd class="rounded-md border bg-surface px-2 py-1 text-[0.6875rem] font-medium"
                  >{shortcut.keys}</kbd
                >
              </div>
            {/each}
          </div>
        {/if}

        <div class="mt-5 flex items-center justify-between">
          <div
            class="flex gap-1"
            aria-label={`${tourLabel} step ${spotlightIndex + 1} of ${spotlightCount}`}
          >
            {#each steps as tourStep (tourStep.selector)}
              <span
                class={`h-1.5 rounded-full ${tourStep.selector === activeSpotlight.selector ? 'w-5 bg-primary' : 'w-1.5 bg-raised'}`}
              ></span>
            {/each}
          </div>
          <div class="flex gap-2">
            {#if tour === 'setup' || step > 0}
              <button
                type="button"
                class="flex h-8 items-center gap-1 rounded-lg border px-3 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
                onclick={previousStep}
              >
                <ArrowLeft size={13} /> Back
              </button>
            {/if}
            <button
              bind:this={nextButton}
              type="button"
              class="flex h-8 items-center gap-1 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover"
              onclick={nextStep}
            >
              {tour === 'setup'
                ? step === 5
                  ? 'Set up'
                  : 'Next'
                : onLastSpotlight
                  ? 'Done'
                  : 'Next'}
              <ArrowRight size={13} />
            </button>
          </div>
        </div>
      </div>
    </div>
  </Portal>
{:else if tour === 'setup' && step === 6}
  <Modal open title="Add your first project" onClose={onFinish} size="lg" closeOnBackdrop={false}>
    <div class="space-y-5">
      <div class="flex items-start gap-4">
        <div
          class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-elevated text-primary"
        >
          <FolderInput size={20} />
        </div>
        <div>
          <p class="mt-1 text-sm leading-relaxed text-muted">
            A project is simply a folder that contains your work. {APP_NAME} adds it to the project sidebar
            so you can work seamlessly.
          </p>
        </div>
      </div>
      <div class="rounded-xl border bg-elevated p-4">
        <p class="text-xs font-medium text-foreground">Good first choices</p>
        <p class="mt-1 text-xs leading-relaxed text-muted">
          Pick an existing app or website folder. If you are learning, you can also make an empty
          folder directly from here or outside the app.
        </p>
      </div>
      <div class="flex items-center justify-between border-t pt-4">
        <button
          type="button"
          class="h-9 rounded-lg px-3 text-sm text-muted transition-colors hover:bg-elevated hover:text-foreground"
          onclick={() => onStepChange(7)}
        >
          Do this later
        </button>
        <button
          type="button"
          class="flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
          data-modal-primary
          onclick={onChooseProject}
        >
          <FolderInput size={15} /> Add a Project
        </button>
      </div>
    </div>
  </Modal>
{:else if tour === 'setup'}
  <Modal
    open
    title="Connect your first coding agent"
    onClose={onFinish}
    size="lg"
    closeOnBackdrop={false}
  >
    <div class="space-y-5">
      <div class="flex items-start gap-4">
        <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-elevated">
          <AgentIcon agentId="pi" size={24} />
        </div>
        <div class="min-w-0 flex-1">
          <p class="mt-1 text-sm leading-relaxed text-muted">
            Pi ships with {APP_NAME}, but uses your installed version if available. It reads your
            request, works in the project folder you choose, and reports the result in the
            conversation.
          </p>
        </div>
      </div>

      {#if piReady}
        <div class="rounded-xl border border-success/30 bg-success/10 p-4">
          <p class="text-sm font-medium text-success">
            {piBundled ? 'Pi is bundled and ready to use.' : 'Pi is installed and ready to use.'}
          </p>
          <p class="mt-1 text-xs leading-relaxed text-muted">
            Connect a Claude, OpenAI, or OpenCode, OpenRouter, etc account from Harness settings,
            then start working.
          </p>
        </div>
      {:else}
        <div class="rounded-xl border bg-elevated p-4">
          <p class="text-sm font-medium">Install Pi, then come back here</p>
          <p class="mt-1 text-xs leading-relaxed text-dimmed">
            The install button opens Pi's instructions for your operating system. After
            installation, choose Check again.
          </p>
          {#if installError}
            <p class="mt-2 text-xs text-danger">{installError}</p>
          {/if}
          <div class="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              class="flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
              data-modal-primary
              disabled={installBusy}
              onclick={() => void openPiInstall()}
            >
              {#if installBusy}
                <Loader2 size={15} class="animate-spin" />
              {:else}
                <Download size={15} />
              {/if}
              {installOpened ? 'Open install guide again' : 'Install Pi'}
            </button>
            <button
              type="button"
              class="flex h-9 items-center gap-2 rounded-lg border px-4 text-sm text-muted transition-colors hover:bg-surface hover:text-foreground disabled:opacity-50"
              disabled={piChecking}
              onclick={() => void checkPi()}
            >
              {#if piChecking}<Loader2 size={14} class="animate-spin" />{/if}
              Check again
            </button>
          </div>
        </div>
      {/if}

      <div class="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <button
          type="button"
          class="h-9 rounded-lg px-3 text-sm text-muted transition-colors hover:bg-elevated hover:text-foreground"
          onclick={onBrowseHarnesses}
        >
          See all coding agents
        </button>
        <div class="flex gap-2">
          {#if !piReady}
            <button
              type="button"
              class="h-9 rounded-lg px-3 text-sm text-muted transition-colors hover:bg-elevated hover:text-foreground"
              onclick={onFinish}
            >
              Skip for now
            </button>
          {/if}
          <button
            type="button"
            class="h-9 rounded-lg bg-primary px-4 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
            onclick={onFinish}
          >
            Finish setup
          </button>
        </div>
      </div>
    </div>
  </Modal>
{/if}
