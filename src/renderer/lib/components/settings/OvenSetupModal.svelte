<script lang="ts">
  import { Loader2, Circle, CheckCircle2, AlertCircle } from '@lucide/svelte'
  import Modal from '../ui/Modal.svelte'
  import DockableModal from '../ui/DockableModal.svelte'
  import Switch from '../ui/Switch.svelte'
  import HarnessToggleGroup from '../shared/HarnessToggleGroup.svelte'
  import SecretVisibilityButton from '../shared/SecretVisibilityButton.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import {
    OVEN_HARNESS_COMMANDS,
    ovenHarnessIdForCommand,
    type Oven,
    type OvenSetupConfiguration,
    type OvenSetupOperation,
    type OvenSetupProgressEvent,
    type OvenSetupPreflightResult
  } from '$shared/ovens'
  import { remoteOvensForSetup } from '$shared/oven-setup-policy'

  interface Props {
    open: boolean
    initialOvenId: string
    onComplete: (ovenId: string) => void
    onClose: () => void
  }

  let { open, initialOvenId, onComplete, onClose }: Props = $props()
  let ovens = $state<Oven[]>([])
  let ovenId = $state('')
  let preflight = $state<OvenSetupPreflightResult | null>(null)
  let preflightBusy = $state(false)
  let startBusy = $state(false)
  let error = $state('')
  let selectedHarnesses = $state<string[]>([])
  let packageUpgrades = $state(true)
  let gitEnabled = $state(false)
  let privateKey = $state('')
  let showPrivateKey = $state(false)
  let operation = $state<OvenSetupOperation | null>(null)
  let progressEvents = $state<OvenSetupProgressEvent[]>([])
  let afterSequence = 0
  let minimized = $state(false)

  const selectedOven = $derived(ovens.find((oven) => oven.id === ovenId))
  const blockers = $derived(preflight?.assessment.issues.filter((issue) => issue.blocking) ?? [])
  const active = $derived(Boolean(operation && ['running', 'preparing'].includes(operation.status)))
  const harnessOptions = $derived(
    OVEN_HARNESS_COMMANDS.flatMap((command) => {
      const id = ovenHarnessIdForCommand(command)
      if (!id) return []
      const observed = preflight?.assessment.harnesses.find((harness) => harness.harnessId === id)
      return [{ id, name: observed?.name ?? id }]
    })
  )

  function toggleAllHarnesses(): void {
    const enabled = !harnessOptions.every((option) => selectedHarnesses.includes(option.id))
    selectedHarnesses = enabled ? harnessOptions.map((option) => option.id) : []
  }

  async function readPreflight(id: string): Promise<void> {
    if (!id) return
    preflightBusy = true
    error = ''
    preflight = null
    try {
      preflight = await invoke('oven:setup:preflight', id)
    } catch (cause) {
      error = message(cause)
    } finally {
      preflightBusy = false
    }
  }

  function message(value: unknown): string {
    return value instanceof Error ? value.message : 'Oven setup could not continue.'
  }

  async function openSetup(): Promise<void> {
    try {
      const state = await invoke('oven:state')
      ovens = remoteOvensForSetup(state.ovens)
      ovenId = ovens.some((oven) => oven.id === initialOvenId)
        ? initialOvenId
        : (ovens[0]?.id ?? '')
      if (ovenId) await readPreflight(ovenId)
    } catch (cause) {
      error = message(cause)
    }
  }

  async function start(): Promise<void> {
    if (!ovenId || blockers.length > 0 || startBusy) return
    startBusy = true
    error = ''
    const configuration: OvenSetupConfiguration = {
      selectedHarnesses: selectedHarnesses.map((harnessId) => ({
        harnessId,
        install: true
      })),
      synchronizeAccounts: true,
      synchronizeConfiguration: true,
      git: { enabled: gitEnabled, host: 'github' },
      packageUpgrades
    }
    try {
      const result = await invoke('oven:setup:start', ovenId, {
        configuration,
        ...(gitEnabled ? { gitIdentity: { privateKey } } : {})
      })
      operation = result
      privateKey = ''
      progressEvents = []
      afterSequence = 0
      minimized = false
      onClose()
      void pollProgress(result.ovenId)
    } catch (cause) {
      error = message(cause)
    } finally {
      startBusy = false
    }
  }

  async function pollProgress(id: string): Promise<void> {
    while (operation && ['running', 'preparing'].includes(operation.status)) {
      try {
        const batch = await invoke('oven:setup:progress', id, afterSequence)
        if (batch.events.length) {
          progressEvents = [...progressEvents, ...batch.events].slice(-200)
          afterSequence = batch.events.at(-1)?.sequence ?? afterSequence
          const last = batch.events.at(-1)
          if (last)
            operation = {
              ...operation,
              status: last.status,
              steps: last.steps,
              updatedAt: Date.now()
            }
        }
        await new Promise((resolve) => setTimeout(resolve, batch.hasMore ? 100 : 700))
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1200))
      }
    }
    if (operation?.status === 'succeeded') onComplete(id)
  }

  async function cancel(): Promise<void> {
    if (!operation || !active) return
    try {
      operation = await invoke('oven:setup:cancel', operation.ovenId)
    } catch (cause) {
      error = message(cause)
    }
  }

  async function retry(): Promise<void> {
    if (!operation) return
    try {
      operation = await invoke('oven:setup:retry', operation.ovenId)
      void pollProgress(operation.ovenId)
    } catch (cause) {
      error = message(cause)
    }
  }

  function setHarness(harnessId: string, enabled: boolean): void {
    selectedHarnesses = enabled
      ? [...new Set([...selectedHarnesses, harnessId])]
      : selectedHarnesses.filter((value) => value !== harnessId)
  }

  function closeProgress(): void {
    minimized = true
  }
</script>

<Modal
  {open}
  title="Set up a remote Oven"
  description="Check prerequisites and install selected harnesses on an SSH Oven."
  {onClose}
  size="lg"
  claimInitialFocus={(panel) => {
    const input = panel.querySelector<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled])'
    )
    if (input) {
      input.focus()
      return true
    }
    return false
  }}
>
  <div
    class="space-y-5"
    {@attach () => {
      void openSetup()
    }}
  >
    <label class="block space-y-1.5 text-sm">
      <span class="text-muted">Remote Oven</span>
      <select
        class="w-full rounded-lg border bg-elevated px-3 py-2 text-foreground"
        bind:value={ovenId}
        onchange={() => void readPreflight(ovenId)}
      >
        {#each ovens as oven (oven.id)}<option value={oven.id}>{oven.name}</option>{/each}
      </select>
    </label>

    {#if !ovens.length}
      <p class="rounded-lg border border-dashed p-3 text-sm text-muted">
        Add an SSH Oven before running setup. Local ovens do not receive package upgrades or full
        setup.
      </p>
    {/if}

    {#if preflightBusy}
      <p class="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={15} class="animate-spin" /> Checking the Oven without making changes
      </p>
    {:else if preflight}
      <section class="space-y-2 rounded-lg border p-3" aria-label="Preflight results">
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-sm font-medium">
            {preflight.report.osName} · {preflight.report.architecture}
          </h3>
          <span class="text-xs text-muted">{preflight.report.packageManager}</span>
        </div>
        <p class="text-xs text-muted">
          Git {preflight.report.git.version ??
            (preflight.report.git.installed ? 'installed' : 'missing')} · curl {preflight.report
            .curl.version ?? (preflight.report.curl.installed ? 'installed' : 'missing')} · Node {preflight
            .report.node.version ?? 'missing'} · npm {preflight.report.npm.version ??
            (preflight.report.npm.installed ? 'installed' : 'missing')}
        </p>
        {#each preflight.assessment.issues as issue (issue.code)}
          <p class="text-xs {issue.blocking ? 'text-danger' : 'text-muted'}">{issue.message}</p>
        {/each}
      </section>
    {/if}

    {#if preflight?.assessment.supported}
      <section class="space-y-3">
        <h3 class="text-sm font-medium">Harnesses to install</h3>
        <HarnessToggleGroup
          options={harnessOptions}
          value={selectedHarnesses}
          onToggle={(id) => setHarness(id, !selectedHarnesses.includes(id))}
          onToggleAll={toggleAllHarnesses}
          label="Select harnesses to install"
        />
        <Switch
          checked={packageUpgrades}
          onchange={(checked) => (packageUpgrades = checked)}
          aria-label="Upgrade package registry and packages"
          title="Upgrade package registry and packages"
          label="Upgrade package registry and packages"
        />
      </section>

      <section class="space-y-3 rounded-lg border p-3">
        <Switch
          checked={gitEnabled}
          onchange={(checked) => (gitEnabled = checked)}
          aria-label="Configure GitHub SSH access"
          title="Configure GitHub SSH access"
          label="Configure GitHub SSH access"
        />
        {#if gitEnabled}
          <label class="block space-y-1.5 text-sm">
            <span class="text-muted">Dedicated GitHub SSH private key</span>
            <div class="flex items-start gap-2">
              <textarea
                class="min-h-28 w-full rounded-lg border bg-elevated px-3 py-2 font-mono text-xs text-foreground"
                style="-webkit-text-security: {showPrivateKey ? 'none' : 'disc'}"
                bind:value={privateKey}
                autocomplete="off"
                spellcheck="false"
                placeholder="Paste a dedicated key for this Oven"></textarea>
              <SecretVisibilityButton
                revealed={showPrivateKey}
                title={showPrivateKey ? 'Hide private key' : 'Show private key'}
                onclick={() => (showPrivateKey = !showPrivateKey)}
              />
            </div>
          </label>
          <p class="text-xs text-muted">
            Use an unencrypted dedicated key, or load an encrypted key into the Oven's ssh-agent
            before setup. The key passphrase is not sent to the Oven.
          </p>
        {/if}
      </section>
    {/if}

    {#if error}<p class="text-sm text-danger" role="alert">{error}</p>{/if}
  </div>
  {#snippet footer()}
    <div class="flex justify-between gap-2">
      <button
        type="button"
        class="rounded-lg border px-3 py-2 text-sm hover:bg-elevated"
        onclick={onClose}>Close</button
      >
      <button
        type="button"
        data-modal-primary
        class="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-on-primary disabled:opacity-50"
        disabled={!selectedOven ||
          !preflight ||
          preflightBusy ||
          blockers.length > 0 ||
          (packageUpgrades && !preflight.assessment.setupCapable) ||
          startBusy ||
          (gitEnabled && !privateKey.trim())}
        onclick={() => void start()}
      >
        {#if startBusy}<Loader2 size={14} class="animate-spin" />{/if}Start setup
      </button>
    </div>
  {/snippet}
</Modal>

{#if operation}
  <DockableModal
    open={true}
    title="Oven setup progress"
    {minimized}
    closable={true}
    onMinimize={() => (minimized = true)}
    onClose={closeProgress}
    storageKey="codeinoven.ovenSetup.progress.v1"
    defaultHeight={460}
    dragLabel="Drag oven setup progress"
  >
    {#snippet dock()}<span class="rounded-full border bg-surface px-3 py-1 text-xs"
        >Oven setup · {operation?.status ?? 'running'}</span
      >{/snippet}
    <div class="space-y-4 p-4">
      <div class="flex items-center justify-between gap-3">
        <div>
          <p class="text-sm font-medium">{selectedOven?.name ?? 'Remote Oven'}</p>
          <p class="text-xs text-muted">{operation.status}</p>
        </div>
        {#if active}<button
            type="button"
            class="rounded-lg border px-2.5 py-1.5 text-xs hover:bg-elevated"
            onclick={() => void cancel()}>Cancel setup</button
          >{:else if ['failed', 'cancelled', 'blocked'].includes(operation.status)}<button
            type="button"
            data-modal-primary
            class="rounded-lg bg-primary px-2.5 py-1.5 text-xs text-on-primary"
            onclick={() => void retry()}>Retry unfinished steps</button
          >{/if}
      </div>
      {#if progressEvents.at(-1)?.message}<p class="text-xs text-muted" role="status">
          {progressEvents.at(-1)?.message}
        </p>{/if}
      <ol class="space-y-2">
        {#each operation.steps as step (step.id)}
          <li class="flex items-start gap-2 rounded-lg border px-3 py-2">
            {#if step.status === 'succeeded'}<CheckCircle2
                size={15}
                class="mt-0.5 text-success"
              />{:else if step.status === 'failed' || step.status === 'blocked'}<AlertCircle
                size={15}
                class="mt-0.5 text-danger"
              />{:else if step.status === 'running'}<Loader2
                size={15}
                class="mt-0.5 animate-spin text-primary"
              />{:else}<Circle size={15} class="mt-0.5 text-muted" />{/if}
            <div class="min-w-0">
              <p class="text-sm">{step.name}</p>
              {#if step.detail || step.error}<p
                  class="mt-0.5 break-words whitespace-pre-wrap text-xs text-muted"
                >
                  {step.error ?? step.detail}
                </p>{/if}
            </div>
          </li>
        {/each}
      </ol>
      {#if error}<p class="text-sm text-danger" role="alert">{error}</p>{/if}
    </div>
  </DockableModal>
{/if}
