<script lang="ts">
  import CioAlertCircle from '@pdslng/cio-icon/CioAlertCircle.svelte'
  import CioCheckCircle from '@pdslng/cio-icon/CioCheckCircle.svelte'
  import CioDownload from '@pdslng/cio-icon/CioDownload.svelte'
  import CioFolder from '@pdslng/cio-icon/CioFolder.svelte'
  import CioPlug from '@pdslng/cio-icon/CioPlug.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { panelReveal } from '$lib/components/layout/page-reveal'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import {
    DEFAULT_LLAMA_CPP_HOST,
    buildLlamaServerArgs,
    describeLlamaServerCommand,
    formatHuggingFaceModelReference,
    isLlamaCppHostValid,
    isLlamaCppPortValid,
    llamaCppEntryProblem,
    llamaCppModelLabel,
    parseHuggingFaceModelReference,
    type LlamaCppServerEntry
  } from '$shared/llama-cpp'
  import { uuidv7 } from '$shared/id'
  import { onDestroy, tick } from 'svelte'
  import { fly } from 'svelte/transition'
  import Modal from '../../ui/Modal.svelte'
  import { stripTerminalEscapes } from './local-ai-controller.svelte'

  interface Props {
    initial: LlamaCppServerEntry
    entries: readonly LlamaCppServerEntry[]
    /** The resolved `llama-server` a row would launch. */
    executable: string
    onClose: () => void
    onSave: (entry: LlamaCppServerEntry) => void | Promise<void>
  }

  let { initial, entries, executable, onClose, onSave }: Props = $props()

  const fieldClass = 'h-9 w-full border bg-elevated px-3 text-sm outline-none focus:border-primary'
  const monoFieldClass =
    'h-9 w-full border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary'

  // The page remounts this editor for every open, so the first values of
  // `initial` are exactly what the form should start from.
  // svelte-ignore state_referenced_locally
  const editing = entries.some((entry) => entry.id === initial.id)
  // svelte-ignore state_referenced_locally
  let name = $state(initial.name)
  // svelte-ignore state_referenced_locally
  let modelPath = $state(initial.modelPath)
  // svelte-ignore state_referenced_locally
  let modelReference = $state(initial.modelReference)
  // svelte-ignore state_referenced_locally
  let host = $state(initial.host || DEFAULT_LLAMA_CPP_HOST)
  // svelte-ignore state_referenced_locally
  let port = $state(String(initial.port))
  // svelte-ignore state_referenced_locally
  let extraFlags = $state(initial.extraFlags)

  /**
   * Which model source the user is filling in. This is intent, not a fact read
   * back from the two fields: the choice has to hold on an empty row, where
   * both fields are still blank and the reference field must open for a paste.
   */
  // svelte-ignore state_referenced_locally
  let source = $state<'local' | 'huggingface'>(
    initial.modelReference.trim().length > 0 ? 'huggingface' : 'local'
  )
  let error = $state('')

  /**
   * The last connection test, stamped with the address it measured. The footer
   * can therefore keep the answer visible while it is still true and drop it the
   * moment the host or port moves, without an effect watching the fields.
   */
  let testResult = $state<{
    address: string
    ok: boolean
    label: string
    message: string
  } | null>(null)
  let testing = $state(false)
  const testedAddress = $derived(`${host.trim()}:${Number(port)}`)
  const visibleTest = $derived(
    testResult && testResult.address === testedAddress ? testResult : null
  )

  /**
   * The reference input, captured by an attachment: choosing Hugging Face is
   * only useful if the caret lands where the URL goes.
   */
  let referenceField: HTMLInputElement | undefined
  function captureReference(node: HTMLInputElement): () => void {
    referenceField = node
    return () => {
      referenceField = undefined
    }
  }

  const parsedReference = $derived(
    modelReference.trim().length > 0 ? parseHuggingFaceModelReference(modelReference) : null
  )

  const draft = $derived<LlamaCppServerEntry>({
    id: initial.id || uuidv7(),
    name: name.trim(),
    modelPath: source === 'local' ? modelPath.trim() : '',
    modelReference: source === 'huggingface' ? modelReference.trim() : '',
    host: host.trim(),
    port: Number(port),
    extraFlags: extraFlags.trim()
  })

  const command = $derived(
    buildLlamaServerArgs(draft).length > 0 ? describeLlamaServerCommand(draft) : ''
  )

  const sourceChoices: Array<{
    id: 'local' | 'huggingface'
    title: string
    hint: string
    icon: typeof CioFolder
  }> = [
    {
      id: 'local',
      title: 'Local GGUF file',
      hint: 'A file already on this machine, referenced where it lives.',
      icon: CioFolder
    },
    {
      id: 'huggingface',
      title: 'Hugging Face',
      hint: 'llama.cpp downloads the model on the first start.',
      icon: CioDownload
    }
  ]

  async function chooseSource(next: 'local' | 'huggingface'): Promise<void> {
    if (source === next) return
    source = next
    error = ''
    if (next === 'huggingface') {
      await tick()
      referenceField?.focus()
    }
  }

  async function pickFile(): Promise<void> {
    const path = await invoke('llamaCpp:pickModel')
    if (!path) return
    modelPath = path
    if (!name.trim() || name.trim() === 'Local server') {
      const segments = path.split(/[\\/]/u)
      name = segments[segments.length - 1] ?? name
    }
  }

  /** Probe the row's own endpoint, which is what a started server answers on. */
  async function testConnection(): Promise<void> {
    const address = `${host.trim()}:${Number(port)}`
    if (!isLlamaCppHostValid(host)) {
      testResult = {
        address,
        ok: false,
        label: 'Not run',
        message: 'Enter a host such as 127.0.0.1.'
      }
      return
    }
    if (!isLlamaCppPortValid(Number(port))) {
      testResult = {
        address,
        ok: false,
        label: 'Not run',
        message: 'Enter a port between 1 and 65535.'
      }
      return
    }
    testing = true
    try {
      const result = await invoke('llamaCpp:probe', host.trim(), Number(port))
      if (result.ready) {
        const models = result.models.slice(0, 3).join(', ')
        testResult = {
          address,
          ok: true,
          label: 'Connected',
          message:
            result.models.length > 0
              ? `Connected · ${models}${result.models.length > 3 ? ` and ${result.models.length - 3} more` : ''}`
              : 'Connected, but the server reports no models.'
        }
      } else {
        // Nothing answers yet, so prove the row itself: launch it exactly as
        // Start would, watch for llama.cpp beginning to load the model, and
        // stop it right there. A full load is not what this test is for.
        await startAndStop(address)
      }
      testing = false
    } catch (failure) {
      testResult = {
        address,
        ok: false,
        label: 'Failed',
        message: failure instanceof Error ? failure.message : 'The test could not run.'
      }
      testing = false
    }
  }

  /** The PTY a running test owns, kept so closing the editor cannot orphan it. */
  let testTerminalId = $state<string | null>(null)
  const testSubscriptions: Array<() => void> = []
  let testTimer: ReturnType<typeof setTimeout> | null = null

  /** llama.cpp announces the moment it starts reading the weights. */
  const LOAD_MARKERS = [
    /load_model: loading model/iu,
    /loading model '/iu,
    /llama_model_load_from_file/iu,
    /llm_load_tensors/iu
  ]
  /** A Hugging Face row fetches the file before there are weights to load. */
  const DOWNLOAD_MARKER = /download/iu

  /** Kill the test's process and drop its listeners, whatever state it is in. */
  function stopTestRun(terminalId: string | null): void {
    if (testTimer) {
      clearTimeout(testTimer)
      testTimer = null
    }
    for (const unsubscribe of testSubscriptions.splice(0)) unsubscribe()
    if (terminalId) void invoke('pty:destroy', terminalId)
    testTerminalId = null
  }

  onDestroy(() => stopTestRun(testTerminalId))

  /**
   * Prove the row the way a start would prove it, without loading the weights:
   * launch the same command Start uses, watch its own output, and stop it the
   * moment llama.cpp says it began loading the model. A bad path, a bad flag or
   * a port that cannot bind fails here instead of on the first real start.
   */
  async function startAndStop(address: string): Promise<void> {
    const terminalId = `local-ai-test-${Date.now()}`
    const tail: string[] = []
    let settled = false
    testTerminalId = terminalId

    const finish = (ok: boolean, label: string, message: string): void => {
      if (settled) return
      settled = true
      stopTestRun(terminalId)
      testResult = { address, ok, label, message }
      testing = false
    }

    const inspect = (chunk: string): void => {
      for (const raw of stripTerminalEscapes(chunk).split(/\r?\n/u)) {
        const line = raw.trim()
        if (line.length === 0) continue
        tail.push(line)
        if (tail.length > 60) tail.shift()
        if (LOAD_MARKERS.some((marker) => marker.test(line))) {
          finish(
            true,
            'Loads',
            `llama-server started and began loading ${llamaCppModelLabel(draft)}; the test stopped it.`
          )
          return
        }
        if (DOWNLOAD_MARKER.test(line)) {
          finish(
            true,
            'Downloads',
            'llama-server started and is fetching the model from Hugging Face; the test stopped it.'
          )
          return
        }
      }
    }

    const tailText = (): string => tail.slice(-3).join(' ') || 'it printed nothing'

    testSubscriptions.push(
      subscribe(`pty:data:${terminalId}`, (chunk) => {
        if (typeof chunk === 'string') inspect(chunk)
      }),
      subscribe(`pty:exit:${terminalId}`, (code) => {
        const exitCode = typeof code === 'number' ? code : 0
        finish(false, 'Failed', `llama-server exited with code ${exitCode}: ${tailText()}`)
      })
    )
    testTimer = setTimeout(() => {
      finish(false, 'Failed', `llama-server never reached the model load in 20s: ${tailText()}`)
    }, 20_000)

    try {
      await invoke(
        'pty:createCommand',
        terminalId,
        executable,
        buildLlamaServerArgs(draft),
        100,
        30
      )
    } catch (error) {
      finish(
        false,
        'Failed',
        error instanceof Error ? error.message : 'llama-server could not be started.'
      )
    }
  }

  function submit(): void {
    const problem = llamaCppEntryProblem(draft, entries)
    if (problem) {
      error = problem
      return
    }
    error = ''
    void onSave(draft)
  }
</script>

<Modal open title={editing ? 'Edit server' : 'Add server'} {onClose} size="lg">
  <form
    id="local-ai-server"
    class="space-y-4"
    onsubmit={(event) => {
      event.preventDefault()
      submit()
    }}
  >
    {#if error}
      <p class="bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</p>
    {/if}

    <fieldset class="space-y-3 border p-3">
      <legend class="px-1 text-xs font-semibold">Server</legend>
      <label class="block space-y-1 text-xs font-medium">
        <span>Name</span>
        <input class={fieldClass} bind:value={name} required maxlength={120} placeholder="LFM2.5" />
      </label>
    </fieldset>

    <fieldset class="space-y-3 border p-3">
      <legend class="px-1 text-xs font-semibold">Model</legend>
      <div class="grid gap-2 md:grid-cols-2">
        {#each sourceChoices as choice (choice.id)}
          <button
            type="button"
            class="group border p-3 text-left transition-colors hover:border-primary hover:bg-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary {source ===
            choice.id
              ? 'border-primary bg-primary/10'
              : 'bg-elevated'}"
            aria-pressed={source === choice.id}
            onclick={() => void chooseSource(choice.id)}
          >
            <span class="flex items-center gap-2">
              <choice.icon size={14} class="shrink-0 text-muted group-hover:text-foreground" />
              <span class="text-xs font-semibold">{choice.title}</span>
            </span>
            <span class="mt-1 block text-[0.6875rem] leading-relaxed text-muted">
              {choice.hint}
            </span>
          </button>
        {/each}
      </div>

      {#key source}
        <!-- Intro only: the outgoing source leaves in the same frame the
             arriving one rises, so the fieldset never holds both blocks. -->
        <div class="space-y-3" in:fly={panelReveal()}>
          {#if source === 'local'}
            <div class="flex gap-2">
              <input
                class={`${monoFieldClass} min-w-0 flex-1`}
                bind:value={modelPath}
                placeholder="/path/to/model.gguf"
                aria-label="Path of the GGUF model"
              />
              <button
                type="button"
                class="flex h-9 shrink-0 items-center gap-1.5 border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
                onclick={() => void pickFile()}
              >
                <CioFolder size={13} />
                Choose file
              </button>
            </div>
          {:else}
            <label class="block space-y-1 text-xs font-medium">
              <span>Reference</span>
              <input
                class={monoFieldClass}
                {@attach captureReference}
                bind:value={modelReference}
                placeholder="LiquidAI/LFM2.5-2.6B-GGUF:Q5_K_M"
              />
            </label>
            {#if parsedReference}
              <p class="text-[0.6875rem] leading-relaxed text-muted">
                llama.cpp downloads <span class="font-mono"
                  >{formatHuggingFaceModelReference(parsedReference)}</span
                >
                on the first start.
              </p>
            {:else if modelReference.trim().length > 0}
              <p class="text-[0.6875rem] text-danger">
                Use <span class="font-mono">owner/repo</span>,
                <span class="font-mono">owner/repo:quant</span>, or a huggingface.co file URL.
              </p>
            {:else}
              <p class="text-[0.6875rem] leading-relaxed text-muted">
                Paste <span class="font-mono">LiquidAI/LFM2.5-2.6B-GGUF</span>, a quant
                <span class="font-mono">owner/repo:Q5_K_M</span>, or a specific file URL.
              </p>
            {/if}
          {/if}
        </div>
      {/key}
    </fieldset>

    <fieldset class="space-y-3 border p-3">
      <legend class="px-1 text-xs font-semibold">Connection</legend>
      <div class="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
        <label class="block space-y-1 text-xs font-medium">
          <span>Host</span>
          <input class={monoFieldClass} bind:value={host} placeholder="127.0.0.1" />
        </label>
        <label class="block space-y-1 text-xs font-medium">
          <span>Port</span>
          <input class={monoFieldClass} bind:value={port} inputmode="numeric" placeholder="8080" />
        </label>
      </div>
      <label class="block space-y-1 text-xs font-medium">
        <span>Extra flags · one per line</span>
        <textarea
          class="min-h-16 w-full border bg-elevated px-3 py-2 font-mono text-xs outline-none focus:border-primary"
          bind:value={extraFlags}
          placeholder="--ctx-size 8192&#10;--threads 8"></textarea>
      </label>
      <p class="text-[0.6875rem] leading-relaxed text-muted">
        A host of <span class="font-mono">127.0.0.1</span> keeps the server on this machine;
        <span class="font-mono">0.0.0.0</span> exposes it to your network. Quoting keeps a value
        together, so <span class="font-mono">--alias "my local model"</span> stays one argument.
      </p>
      {#if visibleTest}
        <div
          class="flex items-start gap-2 border px-3 py-2 {visibleTest.ok
            ? 'border-success/30 bg-success/10'
            : 'border-warning/30 bg-warning/10'}"
        >
          {#if visibleTest.ok}
            <CioCheckCircle size={13} class="mt-0.5 shrink-0 text-success" />
          {:else}
            <CioAlertCircle size={13} class="mt-0.5 shrink-0 text-warning" />
          {/if}
          <p
            class="text-[0.6875rem] leading-relaxed {visibleTest.ok
              ? 'text-success'
              : 'text-warning'}"
          >
            {visibleTest.message}
          </p>
        </div>
      {/if}
    </fieldset>

    {#if command}
      <div class="border bg-raised p-3">
        <p class="text-[0.6875rem] font-medium uppercase tracking-wide text-dimmed">Command</p>
        <p class="mt-1 break-all font-mono text-[0.6875rem] leading-relaxed text-muted">
          {command}
        </p>
      </div>
    {/if}
  </form>

  {#snippet footer()}
    <div class="flex w-full items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <button
          type="button"
          data-modal-dismiss
          class="h-9 border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
          onclick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          class="flex h-9 items-center gap-1.5 border bg-elevated px-3 text-xs font-medium hover:bg-overlay disabled:opacity-50"
          title="Start the row on {testedAddress}, stop it once llama.cpp begins loading the model"
          disabled={testing}
          onclick={() => void testConnection()}
        >
          {#if testing}
            <CioSpinner size={13} class="animate-spin" />
          {:else}
            <CioPlug size={13} />
          {/if}
          Test connection
        </button>
        {#if testing}
          <span class="text-[0.6875rem] text-muted" role="status">Testing…</span>
        {:else if visibleTest}
          <span
            class="flex items-center gap-1 text-[0.6875rem] font-medium {visibleTest.ok
              ? 'text-success'
              : 'text-warning'}"
            role="status"
          >
            {#if visibleTest.ok}
              <CioCheckCircle size={11} />
              {visibleTest.label}
            {:else}
              <CioAlertCircle size={11} />
              {visibleTest.label}
            {/if}
          </span>
        {/if}
      </div>
      <button
        type="submit"
        form="local-ai-server"
        data-modal-primary
        class="flex h-9 items-center gap-1.5 bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
      >
        {editing ? 'Save server' : 'Add server'}
      </button>
    </div>
  {/snippet}
</Modal>
