<script lang="ts">
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { onDestroy, onMount, tick } from 'svelte'
  import { APP_NAME } from '$shared/brand'
  import { ipcErrorMessage } from '$lib/ipc-errors'
  import { invoke } from '$lib/ipc.svelte'
  import { providerStore } from '$lib/stores/providers.svelte'
  import { isMacPlatform } from '$lib/shortcut-display'
  import type { AcpAgentSettings, AcpAgentStatus, AcpKnownAgent } from '$shared/acp'

  /** How long the "Saved" confirmation stays next to the Save button. */
  const SAVED_FEEDBACK_MS = 2000

  let settings = $state<AcpAgentSettings | null>(null)
  let loading = $state(true)
  let saving = $state(false)
  let saved = $state(false)
  let loadError = $state('')
  let saveError = $state('')

  /** Draft fields, refreshed from every status the app reports back. */
  let name = $state('')
  let command = $state('')
  let args = $state('')

  let commandInput = $state<HTMLInputElement | null>(null)
  let savedTimer: ReturnType<typeof setTimeout> | undefined

  /** Attach the command node without `bind:this`, so focus is a plain function. */
  function captureCommand(node: HTMLInputElement): () => void {
    commandInput = node
    return () => {
      if (commandInput === node) commandInput = null
    }
  }

  const status = $derived<AcpAgentStatus | null>(settings?.status ?? null)
  const knownAgents = $derived(settings?.knownAgents ?? [])
  const canSave = $derived(!saving && command.trim().length > 0)
  const submitHint = `${isMacPlatform() ? '⌘' : 'Ctrl'}+Enter also saves`

  function applyStatus(next: AcpAgentStatus): void {
    name = next.configured ? next.name : ''
    command = next.command
    args = next.args.join(' ')
  }

  /** One text field for the arguments; whitespace separates them again on save. */
  function splitArgs(value: string): string[] {
    return value.split(/\s+/u).filter((part) => part.length > 0)
  }

  function applyPreset(agent: AcpKnownAgent): void {
    name = agent.name
    command = agent.command
    args = agent.args.join(' ')
    saveError = ''
    commandInput?.focus({ preventScroll: true })
  }

  function flashSaved(): void {
    clearTimeout(savedTimer)
    saved = true
    savedTimer = setTimeout(() => {
      saved = false
    }, SAVED_FEEDBACK_MS)
  }

  async function load(): Promise<void> {
    loading = true
    try {
      const next = await invoke('acpAgent:get')
      settings = next
      applyStatus(next.status)
    } catch (error) {
      loadError = ipcErrorMessage(error, 'The ACP agent settings could not be read.')
      return
    } finally {
      loading = false
    }
    // The row mounts this panel when it expands, so an empty command is the
    // only field worth focusing: it is the one the user came here to type.
    if (command.trim().length > 0) return
    await tick()
    commandInput?.focus({ preventScroll: true })
  }

  async function save(): Promise<void> {
    if (saving) return
    const nextCommand = command.trim()
    if (nextCommand.length === 0) return
    saving = true
    saveError = ''
    try {
      const next = await invoke('acpAgent:save', {
        name: name.trim() || undefined,
        command: nextCommand,
        args: splitArgs(args)
      })
      settings = next
      applyStatus(next.status)
      flashSaved()
      // The harness row above still shows the previous status, so re-probe it
      // now that the command changed instead of waiting for the next Check.
      void providerStore.checkOne('acp')
    } catch (error) {
      saveError = ipcErrorMessage(error, 'The ACP agent could not be saved.')
    } finally {
      saving = false
    }
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault()
    void save()
  }

  /** Cmd/Ctrl+Enter saves from any field; plain Enter stays inside the field. */
  function onFieldKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.repeat || event.isComposing) return
    if (!event.metaKey && !event.ctrlKey) return
    event.preventDefault()
    event.stopPropagation()
    void save()
  }

  onMount(() => {
    void load()
  })

  onDestroy(() => {
    clearTimeout(savedTimer)
  })
</script>

<div class="space-y-2.5">
  <div>
    <p class="text-xs font-semibold text-foreground">Agent command</p>
    <p class="mt-0.5 text-[0.625rem] text-dimmed">
      Runs any agent that speaks the Agent Client Protocol. {APP_NAME} starts the command you save here
      in ACP mode.
    </p>
  </div>

  {#if loading}
    <p class="flex items-center gap-2 text-xs text-dimmed">
      <CioSpinner size={13} class="animate-spin" /> Reading the saved agent…
    </p>
  {:else if loadError}
    <p class="border border-danger/30 bg-danger/10 px-2.5 py-2 text-xs text-danger" role="alert">
      {loadError}
    </p>
  {:else if status}
    {#if !status.configured}
      <p class="text-[0.6875rem] text-muted">
        This harness runs any agent that speaks ACP: name the command that starts yours, and the
        rest of the app drives it like every other harness.
      </p>
    {:else if status.resolvedPath}
      <p
        class="truncate border border-border bg-raised px-2.5 py-1.5 font-mono text-[0.625rem] text-muted"
        title={status.resolvedPath}
      >
        {status.resolvedPath}
      </p>
    {:else if status.detail}
      <div class="border border-danger/30 bg-danger/10 p-2.5">
        <p class="text-xs font-medium text-danger">The command does not resolve</p>
        <p class="mt-0.5 font-mono text-[0.625rem] break-words text-muted">{status.detail}</p>
      </div>
    {/if}

    <form class="space-y-2.5" onsubmit={submit}>
      <label class="block">
        <span class="text-[0.6875rem] text-muted">Agent name</span>
        <input
          class="mt-1 h-8 w-full border border-border bg-elevated px-2.5 text-xs text-foreground outline-none placeholder:text-dimmed focus:border-primary"
          type="text"
          bind:value={name}
          placeholder="ACP agent"
          disabled={saving}
          onkeydown={onFieldKeydown}
        />
      </label>

      <label class="block">
        <span class="text-[0.6875rem] text-muted">Command</span>
        <input
          {@attach captureCommand}
          class="mt-1 h-8 w-full border border-border bg-elevated px-2.5 font-mono text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
          type="text"
          bind:value={command}
          placeholder="cline"
          spellcheck="false"
          autocomplete="off"
          disabled={saving}
          onkeydown={onFieldKeydown}
        />
      </label>

      <label class="block">
        <span class="text-[0.6875rem] text-muted">Arguments</span>
        <input
          class="mt-1 h-8 w-full border border-border bg-elevated px-2.5 font-mono text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
          type="text"
          bind:value={args}
          placeholder="--acp"
          spellcheck="false"
          autocomplete="off"
          disabled={saving}
          onkeydown={onFieldKeydown}
        />
      </label>

      {#if knownAgents.length > 0}
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="text-[0.625rem] tracking-wide text-dimmed uppercase">Presets</span>
          {#each knownAgents as agent (agent.command)}
            <button
              type="button"
              class="border border-border bg-elevated px-2 py-1 text-[0.6875rem] text-muted transition-colors hover:bg-overlay hover:text-foreground disabled:opacity-50"
              title={`Use ${agent.name}: ${agent.command} ${agent.args.join(' ')}`.trim()}
              disabled={saving}
              onclick={() => applyPreset(agent)}
            >
              {agent.name}
            </button>
          {/each}
        </div>
      {/if}

      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 pt-1.5">
          {#if saveError}
            <p class="text-[0.6875rem] break-words text-danger" role="alert">{saveError}</p>
          {:else if saved}
            <p class="flex items-center gap-1 text-[0.6875rem] text-success">
              <CioCheck size={11} class="shrink-0" /> Saved
            </p>
          {:else}
            <p class="text-[0.625rem] text-dimmed">{submitHint}</p>
          {/if}
        </div>
        <button
          type="submit"
          class="flex h-8 shrink-0 items-center gap-1.5 bg-primary px-2.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
          title="Save the ACP agent command"
          disabled={!canSave}
        >
          {#if saving}
            <CioSpinner size={13} class="animate-spin" />
          {/if}
          Save
        </button>
      </div>
    </form>
  {/if}
</div>
