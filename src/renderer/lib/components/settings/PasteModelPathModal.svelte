<script lang="ts">
  import { LoaderCircle, CheckCircle2, AlertCircle, Info } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { speechSettingsStore as speech } from '$lib/stores/speech.svelte'
  import type { ModelPathValidationResult, ParsedModelIdentity, SpeechCapability } from '../../../../lib/speech/types'
  import { buildParsedIdentityForValidation, describeSupportedFormatsForCapability, inferRuntimeFromExtension } from '../../../../lib/speech/model-path-validation'
  import Modal from '../ui/Modal.svelte'

  interface Props {
    open: boolean
    capability: SpeechCapability
    onClose: () => void
    onImported?: () => void
  }

  let { open, capability, onClose, onImported }: Props = $props()

  let rawPath = $state('')
  let validation = $state<ModelPathValidationResult | null>(null)
  let validating = $state(false)
  let importing = $state(false)
  let debounceId: ReturnType<typeof setTimeout> | null = null
  let lastValidatedFor = $state('')

  const helpText = $derived(describeSupportedFormatsForCapability(capability))
  const placeholder = '/Users/you/models/whisper.mlx  or  /path/to/model.gguf'

  function scheduleValidate(nextRaw: string): void {
    if (debounceId !== null) clearTimeout(debounceId)
    // Immediate empty handling without IPC
    if (nextRaw.trim().length === 0) {
      validating = false
      validation = {
        ok: false,
        normalizedPath: '',
        wasNormalized: false,
        code: 'empty',
        reason: helpText,
        parsedIdentity: null
      }
      return
    }
    validating = true
    debounceId = setTimeout(() => void runValidate(nextRaw), 300)
  }

  async function runValidate(forRaw: string): Promise<void> {
    lastValidatedFor = forRaw
    try {
      const result = await invoke('speech:validateModelPath', forRaw, capability)
      // Only apply if still relevant (avoid stale overwrites)
      if (lastValidatedFor !== forRaw) return
      if (!result.ok) {
        // IPC-level error (e.g. path too long) - map to validation display
        validation = {
          ok: false,
          normalizedPath: forRaw.trim(),
          wasNormalized: false,
          code: 'unsupported-format',
          reason: result.error.message,
          parsedIdentity: buildParsedIdentityForValidation(forRaw.trim(), inferRuntimeFromExtension(forRaw.trim()))
        }
      } else {
        validation = result.value
      }
    } catch (cause) {
      validation = {
        ok: false,
        normalizedPath: forRaw.trim(),
        wasNormalized: false,
        code: 'unsupported-format',
        reason: cause instanceof Error ? cause.message : String(cause),
        parsedIdentity: buildParsedIdentityForValidation(forRaw.trim(), inferRuntimeFromExtension(forRaw.trim()))
      }
    } finally {
      validating = false
    }
  }

  function handleInput(event: Event & { currentTarget: HTMLInputElement }): void {
    rawPath = event.currentTarget.value
    scheduleValidate(rawPath)
  }

  // Validate on open and on rawPath changes via schedule
  $effect(() => {
    if (open) {
      // Small delay to let Modal focus handling run, then validate current value
      scheduleValidate(rawPath)
    } else {
      if (debounceId !== null) clearTimeout(debounceId)
      debounceId = null
      validating = false
      // Do not clear rawPath immediately so that reopening retains? Spec says fresh; reset on close
    }
  })

  function resetAndClose(): void {
    if (debounceId !== null) clearTimeout(debounceId)
    debounceId = null
    validating = false
    importing = false
    rawPath = ''
    validation = null
    onClose()
  }

  async function handleImport(): Promise<void> {
    if (!validation?.ok || validating || importing) return
    importing = true
    try {
      const ok = await speech.importModel(validation.normalizedPath, capability)
      if (ok) {
        onImported?.()
        resetAndClose()
      }
    } finally {
      importing = false
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && validation?.ok && !validating && !importing) {
      event.preventDefault()
      void handleImport()
    }
  }

  const canImport = $derived(validation?.ok === true && !validating && !importing)
  const showNormalizedHint = $derived(
    validation !== null && validation.wasNormalized && rawPath.trim().length > 0
  )

  // Show breakup immediately from pasted path even before main-process stat, and from returned validation after
  const liveParsed = $derived.by((): ParsedModelIdentity | null => {
    if (validation?.parsedIdentity) return validation.parsedIdentity
    const raw = rawPath.trim()
    if (!raw) return null
    // Strip outer quotes like normalizePastedPath for preview
    let norm = raw
    if (norm.length >= 2 && ((norm[0] === '"' && norm[norm.length - 1] === '"') || (norm[0] === "'" && norm[norm.length - 1] === "'"))) {
      const inner = norm.slice(1, -1).trim()
      if (inner) norm = inner
    }
    const runtime = inferRuntimeFromExtension(norm)
    return buildParsedIdentityForValidation(norm, runtime)
  })
  const hasBreakup = $derived(liveParsed !== null && liveParsed.details.length > 0)
</script>

<Modal open={open} title="Paste model path" onClose={resetAndClose} size="md">
  <div class="space-y-4" onkeydown={handleKeydown} role="presentation">
    <p class="text-xs text-muted">
      Paste a local filesystem path. {helpText} Path is validated locally; no download is performed.
    </p>

    <label class="block text-xs font-medium text-muted" for="paste-model-path-input">
      Model path
      <input
        id="paste-model-path-input"
        class="mt-1 w-full rounded-lg border bg-elevated px-3 py-2.5 font-mono text-xs outline-none focus:border-primary"
        type="text"
        placeholder={placeholder}
        autocomplete="off"
        spellcheck="false"
        value={rawPath}
        oninput={handleInput}
      />
    </label>

    {#if showNormalizedHint}
      <p class="flex items-center gap-1.5 text-[11px] text-dimmed">
        <Info size={12} aria-hidden="true" />
        Trimmed surrounding quotes and whitespace before validation.
      </p>
    {/if}

    <div
      class="min-h-6 rounded-lg px-3 py-2 text-xs"
      class:bg-success-soft={validation?.ok}
      class:text-success={validation?.ok}
      class:bg-danger-soft={validation !== null && !validation.ok && validation.code !== 'empty'}
      class:text-danger={validation !== null && !validation.ok && validation.code !== 'empty'}
      class:bg-surface={validation?.code === 'empty'}
      class:text-muted={validation?.code === 'empty'}
      class:border={true}
      class:border-success-border={validation?.ok}
      class:border-danger-border={validation !== null && !validation.ok && validation.code !== 'empty'}
      class:border-border={validation?.code === 'empty'}
      role="status"
      aria-live="polite"
    >
      {#if validating}
        <span class="inline-flex items-center gap-1.5">
          <LoaderCircle size={12} class="animate-spin" aria-hidden="true" />
          Validating path…
        </span>
      {:else if validation?.ok}
        <span class="inline-flex items-center gap-1.5">
          <CheckCircle2 size={12} aria-hidden="true" />
          {validation.reason}
        </span>
      {:else if validation !== null && validation.code === 'empty'}
        <span class="inline-flex items-center gap-1.5">
          <Info size={12} aria-hidden="true" />
          {validation.reason}
        </span>
      {:else if validation !== null}
        <span class="inline-flex items-center gap-1.5">
          <AlertCircle size={12} aria-hidden="true" />
          {validation.reason}
        </span>
      {:else}
        <span class="text-muted">Paste a path to validate.</span>
      {/if}
    </div>

    {#if hasBreakup && liveParsed}
      <div class="rounded-xl border bg-surface p-3">
        <p class="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted">
          <span>Detected model</span>
          {#if liveParsed.confidence === 'high'}
            <span class="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">High confidence</span>
          {:else if liveParsed.confidence === 'medium'}
            <span class="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600">Medium confidence</span>
          {:else}
            <span class="rounded-full bg-surface-hover px-2 py-0.5 text-[10px] font-medium text-dimmed">Low confidence</span>
          {/if}
        </p>
        <p class="text-sm font-semibold leading-none" title={liveParsed.baseWithoutExtension}>{liveParsed.displayName}</p>
        <p class="mt-1 truncate font-mono text-[11px] text-dimmed" title={liveParsed.rawBasename}>{liveParsed.rawBasename}</p>
        <div class="mt-2 flex flex-wrap gap-1.5">
          {#each liveParsed.details as d (d.label)}
            <span class="inline-flex items-center gap-1 rounded-full border bg-elevated px-2 py-0.5 text-[11px]">
              <span class="font-medium text-muted">{d.label}:</span>
              <span class="font-semibold">{d.value}</span>
            </span>
          {/each}
        </div>
        {#if liveParsed.tokens.length}
          <p class="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-dimmed">
            <span class="text-[10px] uppercase tracking-wide">Breakup:</span>
            {#each liveParsed.tokens as tok, i (i)}
              <code class="rounded bg-elevated px-1 py-0.5 font-mono text-[11px]">{tok}</code>
              {#if i < liveParsed.tokens.length - 1}<span class="opacity-40">·</span>{/if}
            {/each}
          </p>
        {/if}
      </div>
    {/if}

    {#if validation !== null && !validation.ok && validation.code === 'unsupported-format'}
      <p class="text-[11px] text-dimmed">
        Tip: use an absolute path. On macOS/Linux use <code class="rounded bg-elevated px-1">/path/to/model</code>,
        on Windows use <code class="rounded bg-elevated px-1">C:\path\to\model</code>. Case is
        platform-dependent.
      </p>
    {/if}

    {#if validation !== null && validation.code === 'permission-denied'}
      <p class="text-[11px] text-dimmed">
        Check file permissions or try a different location.
      </p>
    {/if}

    {#if validation !== null && validation.code === 'not-found'}
      <p class="text-[11px] text-dimmed">
        Verify the path exists and is accessible.
      </p>
    {/if}
  </div>

  {#snippet footer()}
    <button type="button" class="rounded-lg border px-3 py-1.5 text-sm" onclick={resetAndClose}>
      Cancel
    </button>
    <button
      type="button"
      class="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-on-primary disabled:opacity-40"
      disabled={!canImport}
      data-modal-primary
      onclick={() => void handleImport()}
    >
      {#if importing}
        <LoaderCircle size={13} class="mr-1 inline animate-spin" aria-hidden="true" />
      {/if}
      Import
    </button>
  {/snippet}
</Modal>

<style>
  .bg-success-soft {
    background: color-mix(in srgb, var(--color-success) 10%, transparent);
  }
  .bg-danger-soft {
    background: color-mix(in srgb, var(--color-danger) 10%, transparent);
  }
  .text-success {
    color: var(--color-success);
  }
  .text-danger {
    color: var(--color-danger);
  }
  .border-success-border {
    border-color: color-mix(in srgb, var(--color-success) 25%, transparent);
  }
  .border-danger-border {
    border-color: color-mix(in srgb, var(--color-danger) 25%, transparent);
  }
</style>
