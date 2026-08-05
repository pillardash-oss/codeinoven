<script lang="ts">
  import { onMount } from 'svelte'
  import { fade } from 'svelte/transition'
  import {
    AlertTriangle,
    CheckCircle2,
    Circle,
    Download,
    Loader2,
    Plug,
    Plus,
    RefreshCw,
    Trash2
  } from '@lucide/svelte'
  import { providerStore } from '$lib/stores/providers.svelte'
  import { baseUrlProviderStore } from '$lib/stores/base-url-providers.svelte'
  import { harnessLifecycleStore } from '$lib/stores/harness-lifecycle.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { toast } from 'svelte-sonner'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { APP_NAME } from '$shared/brand'
  import type { ProviderAccountAuthStatus, ProviderConnectionInfo } from '$shared/types'
  import BaseUrlProvidersPanel from './BaseUrlProvidersPanel.svelte'
  import AddProviderModal from './AddProviderModal.svelte'
  import BaseUrlProviderEditor from './BaseUrlProviderEditor.svelte'
  import Modal from '../ui/Modal.svelte'

  /** Harnesses whose drivers can consume custom base-URL providers (per the manifest). */
  let baseUrlHarnesses = $derived(
    providerStore.providers.filter(
      (provider) => provider.supportsCustomProviders && provider.integration === 'ready'
    )
  )

  let authStatuses = $state<Record<string, ProviderAccountAuthStatus>>({})
  let addTarget = $state<ProviderConnectionInfo | null>(null)
  let customEditorFor = $state<string | null>(null)
  /** Harness awaiting uninstall confirmation, with its resolved handoff command. */
  let uninstallTarget = $state<ProviderConnectionInfo | null>(null)
  let uninstallCommand = $state<string>('')
  let uninstallLoading = $state(false)
  let uninstallError = $state('')
  let uninstallBusy = $state(false)

  async function openInstallPage(provider: ProviderConnectionInfo): Promise<void> {
    try {
      const info = await invoke('harnessInstall:getInfo', provider.id)
      await openInBrowser(info.pageUrl)
    } catch (installError) {
      toast.error(
        installError instanceof Error ? installError.message : 'Install page unavailable.'
      )
    }
  }

  async function requestUninstall(provider: ProviderConnectionInfo): Promise<void> {
    if (harnessLifecycleStore.isRunning(provider.id)) return
    // Open the confirmation prompt immediately — the command resolves inside it.
    uninstallTarget = provider
    uninstallCommand = ''
    uninstallError = ''
    uninstallLoading = true
    try {
      const handoff = await invoke('harnessUninstall:handoff', provider.id)
      uninstallCommand = `$ ${handoff.command} ${handoff.args.join(' ')}`
    } catch (uninstallErrorValue) {
      uninstallError =
        uninstallErrorValue instanceof Error
          ? uninstallErrorValue.message
          : 'Uninstall unavailable.'
    } finally {
      uninstallLoading = false
    }
  }

  async function confirmUninstall(): Promise<void> {
    if (!uninstallTarget || uninstallLoading || uninstallError) return
    const target = uninstallTarget
    uninstallBusy = true
    try {
      await harnessLifecycleStore.startUninstall(target.id, target.name)
      uninstallTarget = null
      uninstallCommand = ''
    } finally {
      uninstallBusy = false
    }
  }

  function cancelUninstall(): void {
    if (uninstallBusy) return
    uninstallTarget = null
    uninstallCommand = ''
    uninstallError = ''
  }

  function customCountFor(harnessId: string): number {
    return baseUrlProviderStore.providers.filter(
      (provider) => provider.harnessId === harnessId && provider.enabled
    ).length
  }

  function authCountFor(harnessId: string): number {
    return authStatuses[harnessId]?.accounts?.length ?? 0
  }

  function totalProviderCount(harness: ProviderConnectionInfo): number {
    return customCountFor(harness.id) + authCountFor(harness.id)
  }

  async function checkAuth(harnessId: string): Promise<void> {
    try {
      authStatuses[harnessId] = await invoke('providerAccounts:getAuthStatus', harnessId)
    } catch (authError) {
      authStatuses[harnessId] = {
        capabilities: null,
        state: 'error',
        accounts: [],
        detail: authError instanceof Error ? authError.message : 'Authentication check failed.'
      }
    }
  }

  async function checkAllAuth(): Promise<void> {
    const ready = providerStore.providers.filter(
      (provider) => provider.integration === 'ready' && provider.status === 'available'
    )
    await Promise.all(ready.map((provider) => checkAuth(provider.id)))
  }

  async function recheckAll(): Promise<void> {
    await providerStore.checkAll()
    await checkAllAuth()
    await harnessLifecycleStore.checkAll()
  }

  async function checkOne(id: string): Promise<void> {
    await providerStore.checkOne(id)
    const provider = providerStore.providers.find((candidate) => candidate.id === id)
    if (provider?.status === 'available') await checkAuth(id)
    await harnessLifecycleStore.checkOne(id)
  }

  function canAddProvider(provider: ProviderConnectionInfo): boolean {
    return provider.integration === 'ready' && provider.status === 'available'
  }

  onMount(() => {
    void (async () => {
      await providerStore.init()
      await baseUrlProviderStore.load()
      await checkAllAuth()
      await harnessLifecycleStore.checkAll()
    })()
  })
</script>

<div class="mx-auto max-w-5xl p-6 pb-24">
  <div class="mb-6 flex items-start justify-between">
    <div>
      <h1 class="text-xl font-bold tracking-tight">Harnesses</h1>
      <p class="mt-0.5 text-sm text-muted">
        Connect the AI coding harnesses you use. {APP_NAME} wraps them — it doesn't replace them.
      </p>
    </div>
    <button
      class="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
      title="Re-check all harnesses"
      onclick={() => void recheckAll()}
      disabled={providerStore.checkingCount > 0}
    >
      <RefreshCw size={12} class={providerStore.checkingCount > 0 ? 'animate-spin' : ''} />
      Re-check all
    </button>
  </div>

  <div class="space-y-3">
    {#each providerStore.providers as provider (provider.id)}
      <div class="relative flex items-center justify-between rounded-xl border bg-surface p-4">
        {#if harnessLifecycleStore.updateAvailableFor(provider.id)}
          <span
            class="absolute -top-2.5 left-3 z-10 flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] font-semibold text-warning"
            title="A newer version of {provider.name} is available"
          >
            <Download size={10} /> Update available
          </span>
        {/if}
        <div class="flex items-center gap-3">
          <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-elevated">
            <AgentIcon agentId={provider.id} label={provider.name} size={20} />
          </div>
          <div>
            <p class="text-sm font-medium">{provider.name}</p>
            <p class="text-xs text-dimmed">
              <span class="rounded bg-elevated px-1 py-0.5 font-mono text-[10px]"
                >{provider.command}</span
              >
              {#if provider.version}
                <span class="ml-1.5 font-mono text-[10px] text-dimmed">{provider.version}</span>
              {/if}
            </p>
            {#if provider.status === 'available'}
              <p class="mt-0.5 text-[10px] text-dimmed">
                {totalProviderCount(provider)} provider{totalProviderCount(provider) === 1
                  ? ''
                  : 's'}{#if authStatuses[provider.id] !== undefined}
                  · {customCountFor(provider.id)} custom · {authCountFor(provider.id)} signed in
                {/if}
              </p>
            {/if}
          </div>
        </div>

        <div class="flex items-center gap-2">
          {#key provider.status}
            <div class="flex items-center gap-1.5" in:fade={{ duration: 180 }}>
              {#if provider.status === 'available' && provider.integration === 'ready'}
                <CheckCircle2 size={16} class="shrink-0 text-success" />
                <span
                  class="max-w-40 truncate text-xs font-medium text-success"
                  title={provider.resolvedPath}
                >
                  {provider.resolvedPath ?? 'Ready'}
                </span>
              {:else if provider.status === 'available'}
                <Circle size={16} class="shrink-0 text-warning" />
                <span class="text-xs text-warning">Detected · integration planned</span>
              {:else if provider.status === 'checking'}
                <Loader2 size={16} class="shrink-0 animate-spin text-info" />
                <span class="text-xs text-info">Checking...</span>
              {:else if provider.status === 'not_found'}
                <Circle size={16} class="shrink-0 text-dimmed" />
                <span class="text-xs text-dimmed">Not installed</span>
              {:else if provider.status === 'error'}
                <AlertTriangle size={16} class="shrink-0 text-danger" />
                <span class="max-w-40 truncate text-xs text-danger" title={provider.detail}>
                  {provider.detail ?? 'Error'}
                </span>
              {:else}
                <Circle size={16} class="shrink-0 text-dimmed" />
                <span class="text-xs text-dimmed">Not checked</span>
              {/if}
            </div>
          {/key}
          {#if provider.status === 'not_found'}
            <button
              class="flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/15"
              title="Open the {provider.name} install page for your operating system"
              onclick={() => void openInstallPage(provider)}
            >
              <Download size={13} />
              Install
            </button>
          {/if}
          {#if harnessLifecycleStore.updateAvailableFor(provider.id)}
            <button
              class="flex items-center gap-1.5 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning/15 disabled:opacity-50"
              title="Update {provider.name} to {harnessLifecycleStore.updateAvailableFor(
                provider.id
              )?.latestVersion}"
              disabled={harnessLifecycleStore.isRunning(provider.id)}
              onclick={() => void harnessLifecycleStore.startUpdate(provider.id, provider.name)}
            >
              {#if harnessLifecycleStore.isRunning(provider.id)}
                <Loader2 size={13} class="animate-spin" />
              {:else}
                <Download size={13} />
              {/if}
              Update
            </button>
          {/if}
          <button
            class="rounded-lg border px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
            title="Check whether {provider.name} is installed"
            onclick={() => void checkOne(provider.id)}
            disabled={provider.status === 'checking'}
          >
            Check
          </button>
          {#if provider.status === 'available'}
            <button
              class="flex items-center gap-1.5 rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/15 disabled:opacity-50"
              title="Uninstall {provider.name} from this machine"
              disabled={harnessLifecycleStore.isRunning(provider.id)}
              onclick={() => void requestUninstall(provider)}
            >
              <Trash2 size={13} />
              Uninstall
            </button>
          {/if}
          <button
            class="flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
            title={canAddProvider(provider)
              ? `Add a provider to ${provider.name}`
              : 'Install the harness first, then re-check to add providers'}
            disabled={!canAddProvider(provider)}
            onclick={() => (addTarget = provider)}
          >
            <Plus size={13} /> Add provider
          </button>
        </div>
      </div>
    {/each}
  </div>

  <div class="mt-6 rounded-xl border border-dashed p-4 text-center">
    <Plug size={18} class="mx-auto mb-1 text-dimmed" />
    <p class="text-xs text-dimmed">
      Harnesses are detected from your system PATH and verified with a version probe. Install the
      CLI tool and click Check.
    </p>
  </div>

  <BaseUrlProvidersPanel providers={providerStore.providers} />
</div>

{#if addTarget}
  <AddProviderModal
    harness={addTarget}
    onClose={() => (addTarget = null)}
    onAddCustom={(harnessId) => {
      customEditorFor = harnessId
      addTarget = null
    }}
  />
{/if}

{#if customEditorFor}
  <BaseUrlProviderEditor
    provider={null}
    harnesses={baseUrlHarnesses}
    defaultHarnessId={customEditorFor}
    onClose={() => (customEditorFor = null)}
    onSaved={() => (customEditorFor = null)}
  />
{/if}

{#if uninstallTarget}
  <Modal open title={`Uninstall ${uninstallTarget.name}?`} onClose={cancelUninstall}>
    {#snippet footer()}
      <button
        class="h-9 rounded-lg border px-3 text-xs font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
        onclick={cancelUninstall}
      >
        Cancel
      </button>
      <button
        class="flex h-9 items-center gap-1.5 rounded-lg bg-danger px-3 text-xs font-semibold text-on-primary transition-colors hover:bg-danger/90 disabled:opacity-50"
        onclick={() => void confirmUninstall()}
        disabled={uninstallBusy || uninstallLoading || !!uninstallError}
      >
        {#if uninstallBusy}
          <Loader2 size={13} class="animate-spin" />
        {:else}
          <Trash2 size={13} />
        {/if}
        Uninstall
      </button>
    {/snippet}
    <div class="space-y-3 text-sm">
      <p class="text-muted">
        This removes {uninstallTarget.name} from your machine using its documented uninstall command.
        The command runs in the embedded terminal where you can watch it and stop it at any time.
      </p>
      {#if uninstallLoading}
        <div
          class="flex items-center gap-2 rounded-lg border border-border bg-raised p-3 font-mono text-xs text-muted"
        >
          <Loader2 size={13} class="animate-spin" />
          Resolving uninstall command…
        </div>
      {:else if uninstallError}
        <div class="rounded-lg border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
          {uninstallError}
        </div>
      {:else}
        <pre
          class="overflow-auto rounded-lg border border-border bg-raised p-3 font-mono text-xs leading-relaxed text-foreground"><code
            >{uninstallCommand}</code
          ></pre>
        <p class="text-xs text-dimmed">
          Your provider accounts and project data in {APP_NAME} are separate from the harness install
          and are not removed.
        </p>
      {/if}
    </div>
  </Modal>
{/if}
