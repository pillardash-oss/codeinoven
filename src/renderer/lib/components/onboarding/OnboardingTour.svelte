<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { Portal } from 'bits-ui'
  import {
    ArrowLeft,
    ArrowRight,
    Check,
    Download,
    FolderInput,
    FolderKanban,
    Loader2,
    MessageSquare,
    PanelRight,
    Sparkles,
    X
  } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { providerStore } from '$lib/stores/providers.svelte'
  import { APP_NAME } from '$shared/brand'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'

  interface Props {
    step: number
    onStepChange: (step: number) => void
    onChooseProject: () => void
    onBrowseHarnesses: () => void
    onFinish: () => void
  }

  interface SpotlightStep {
    step: number
    selector: string
    eyebrow: string
    title: string
    description: string
  }

  interface TargetRect {
    top: number
    left: number
    width: number
    height: number
  }

  let { step, onStepChange, onChooseProject, onBrowseHarnesses, onFinish }: Props = $props()

  const spotlightSteps: SpotlightStep[] = [
    {
      step: 1,
      selector: '[data-onboarding="view-switcher"]',
      eyebrow: 'Conversation View type',
      title: 'Projects|Threads|Scope|Chats',
      description:
        "Projects groups by folder. Threads shows every project conversation. Scope is for board view and worktrees. Chat is for tasks that don't need a projects for a start."
    },
    {
      step: 2,
      selector: '[data-onboarding="project-sidebar"]',
      eyebrow: 'Left Sidebar',
      title: 'Threads and Projects',
      description:
        'The sidebar holds your projects and conversations. Pick a project, then open a thread or start a new one.'
    },
    {
      step: 3,
      selector: '[data-onboarding="conversation"]',
      eyebrow: 'Conversation',
      title: 'Work with the agent here',
      description:
        'Messages, questions, plans, approvals, and results all stay in this main area. You can follow the work without opening a terminal.'
    },
    {
      step: 4,
      selector: '[data-onboarding="composer"]',
      eyebrow: 'Send and steer',
      title: 'Type what you want done',
      description:
        "The composer accepts plain instructions, file attachments of all kinds. You can also dictate with the microphone, or tap it to read the agent's response. Check the sound settings for more"
    },
    {
      step: 5,
      selector: '[data-onboarding="notifications"]',
      eyebrow: 'Context and alerts',
      title: 'Tools open on the right',
      description:
        'Notifications, files, Git changes, terminals, sources, and memory open in the right sidebar. The bell collects completed work and anything that needs you.'
    }
  ]

  const activeSpotlight = $derived(spotlightSteps.find((item) => item.step === step))
  const isMac = navigator.platform.toUpperCase().includes('MAC')
  const sendShortcut = isMac ? '⌘ Enter' : 'Ctrl + Enter'
  const steerShortcut = isMac ? '⌘ ⇧ Enter' : 'Ctrl + Shift + Enter'
  const spotlightCount = spotlightSteps.length

  let targetRect = $state<TargetRect | null>(null)
  let calloutTop = $state(0)
  let calloutLeft = $state(0)
  let nextButton = $state<HTMLButtonElement | undefined>(undefined)
  let installOpened = $state(false)
  let installBusy = $state(false)
  let installError = $state('')

  const pi = $derived(providerStore.providers.find((provider) => provider.id === 'pi'))
  const piReady = $derived(
    pi?.status === 'available' && pi.integration === 'ready' && pi.unsupportedReason === undefined
  )
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
    const cardHeight = step === 4 ? 270 : 220
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

  function nextStep(): void {
    onStepChange(step < 5 ? step + 1 : 6)
  }

  function previousStep(): void {
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
    if (event.key === 'Escape') onFinish()
  }}
/>

{#if step === 0}
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
        class="fixed w-[340px] rounded-2xl border bg-surface p-5 shadow-xl"
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
            title="Skip setup"
            aria-label="Skip setup"
            onclick={onFinish}
          >
            <X size={15} />
          </button>
        </div>
        <p class="mt-2 text-sm leading-relaxed text-muted">{activeSpotlight.description}</p>

        {#if step === 4}
          <div class="mt-4 grid gap-2">
            <div class="flex items-center justify-between rounded-lg border bg-elevated px-3 py-2">
              <span class="text-xs text-muted">Send a message</span>
              <kbd class="rounded-md border bg-surface px-2 py-1 text-[0.6875rem] font-medium"
                >{sendShortcut}</kbd
              >
            </div>
            <div class="flex items-center justify-between rounded-lg border bg-elevated px-3 py-2">
              <span class="text-xs text-muted">Steer a working agent now</span>
              <kbd class="rounded-md border bg-surface px-2 py-1 text-[0.6875rem] font-medium"
                >{steerShortcut}</kbd
              >
            </div>
          </div>
        {/if}

        <div class="mt-5 flex items-center justify-between">
          <div class="flex gap-1" aria-label={`Tour step ${step} of ${spotlightCount}`}>
            {#each spotlightSteps as item (item.step)}
              <span
                class={`h-1.5 rounded-full ${item.step === step ? 'w-5 bg-primary' : 'w-1.5 bg-raised'}`}
              ></span>
            {/each}
          </div>
          <div class="flex gap-2">
            <button
              type="button"
              class="flex h-8 items-center gap-1 rounded-lg border px-3 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
              onclick={previousStep}
            >
              <ArrowLeft size={13} /> Back
            </button>
            <button
              bind:this={nextButton}
              type="button"
              class="flex h-8 items-center gap-1 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover"
              onclick={nextStep}
            >
              {step === 5 ? 'Set up' : 'Next'}
              <ArrowRight size={13} />
            </button>
          </div>
        </div>
      </div>
    </div>
  </Portal>
{:else if step === 6}
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
{:else}
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
