<script lang="ts">
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import { toast } from 'svelte-sonner'
  import {
    bundledPiFilePatterns,
    DEFAULT_BUNDLED_PI_FILE_PATTERNS,
    MAX_BUNDLED_PI_FILE_PATTERNS,
    PERMANENT_BUNDLED_PI_FILE_PATTERNS,
    validateBundledPiFilePatterns
  } from '$shared/bundled-pi-file-protection'
  import type { AppConfig, AppConfigPatch } from '$shared/types'
  import { appConfirm } from '../../stores/app-confirm.svelte'
  import { keymapState } from '../../keymap/keymap-state.svelte'

  interface Props {
    config: AppConfig
    settingsReady: boolean
    updateConfig: (patch: AppConfigPatch) => Promise<void>
  }

  let { config, settingsReady, updateConfig }: Props = $props()
  let candidate = $state('')
  let saving = $state(false)
  const patterns = $derived(bundledPiFilePatterns(config.bundledPiSensitiveFilePatterns))
  const atCapacity = $derived(patterns.length >= MAX_BUNDLED_PI_FILE_PATTERNS)

  async function save(next: string[]): Promise<void> {
    saving = true
    try {
      await updateConfig({ bundledPiSensitiveFilePatterns: validateBundledPiFilePatterns(next) })
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Could not save protected file patterns.'
      )
    } finally {
      saving = false
    }
  }

  async function addPattern(): Promise<void> {
    if (saving || !settingsReady) return
    try {
      const [pattern] = validateBundledPiFilePatterns([candidate])
      if (
        !pattern ||
        patterns.includes(pattern) ||
        PERMANENT_BUNDLED_PI_FILE_PATTERNS.includes(pattern)
      ) {
        toast.error('That pattern is already protected.')
        return
      }
      const next = validateBundledPiFilePatterns([...patterns, pattern])
      await save(next)
      candidate = ''
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add this pattern.')
    }
  }

  async function removePattern(pattern: string): Promise<void> {
    if (saving || !settingsReady) return
    const approved = await appConfirm.request({
      title: 'Remove protected file pattern?',
      body: [
        `Remove ${pattern} from bundled Pi's block list?`,
        patterns.length === 1
          ? 'Secret-tool files remain permanently protected. File-capable tools will still require approval, including in Full Access.'
          : 'Other entries remain protected. Removing a pattern does not remove any files.'
      ],
      confirmLabel: 'Remove pattern',
      tone: 'danger'
    })
    if (!approved || saving) return
    await save(patterns.filter((entry) => entry !== pattern))
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault()
    void addPattern()
  }
</script>

<section
  id="settings-block-general-bundled-pi-files"
  class="max-h-[32rem] overflow-y-auto border bg-surface p-4"
  aria-label="Bundled Pi sensitive file protection"
>
  <h3
    class="mb-3 border-b border-border pb-2 text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase"
  >
    Sensitive files · Bundled Pi only
  </h3>
  <p class="text-sm font-medium">Require approval for protected files</p>
  <p class="mt-1 text-xs leading-relaxed text-dimmed">
    Applies only to CodeInOven's bundled Pi. External Pi installations and other harnesses are
    unaffected. Full Access cannot bypass this gate, and each approval allows one tool invocation.
    Changes apply to subsequent tool calls.
  </p>
  <p class="mt-2 text-xs leading-relaxed text-dimmed">
    Bundled Pi asks before every tool that can access files, including ordinary reads, shell
    commands, scripts, searches, and utilities. This also covers indirect access whose target cannot
    be known before execution. Questions and task status stay available.
  </p>
  <p class="mt-2 text-xs leading-relaxed text-dimmed">
    Files created by the secret tool are always protected. Their app-data directory cannot be
    removed from this list, including when there are no additional entries.
  </p>

  {#if patterns.length === 0}
    <p class="mt-3 border border-border p-3 text-xs text-muted" role="status">
      No additional entries. Secret-tool files remain protected and approval is still required.
    </p>
  {/if}

  <ul class="mt-3 divide-y divide-border border border-border">
    {#each PERMANENT_BUNDLED_PI_FILE_PATTERNS as pattern (pattern)}
      <li class="flex items-center justify-between gap-3 bg-elevated px-3 py-2">
        <div class="min-w-0">
          <code class="break-all text-xs">{pattern}</code>
          <p class="text-xs text-dimmed">Secret-tool files in app data</p>
        </div>
        <span class="shrink-0 text-xs font-medium text-muted">Always protected</span>
      </li>
    {/each}
    {#each patterns as pattern (pattern)}
      <li class="flex items-center justify-between gap-3 px-3 py-2">
        <code class="min-w-0 break-all text-xs">{pattern}</code>
        <button
          type="button"
          class="shrink-0 p-1 text-muted hover:text-danger disabled:opacity-40"
          title={`Remove ${pattern} from bundled Pi's block list`}
          aria-label={`Remove ${pattern} from bundled Pi's block list`}
          disabled={!settingsReady || saving}
          onclick={() => void removePattern(pattern)}
        >
          <CioClose size={14} />
        </button>
      </li>
    {/each}
  </ul>

  <form class="mt-3 flex items-end gap-2" onsubmit={submit}>
    <label class="min-w-0 flex-1 text-xs text-dimmed">
      File name, path, or pattern
      <input
        class="mt-1 w-full border border-border bg-app px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
        bind:value={candidate}
        placeholder=".env.*, *.pub, secrets/"
        maxlength={256}
        disabled={!settingsReady || saving || atCapacity}
        onkeydown={(event) => {
          if (
            !event.repeat &&
            !event.isComposing &&
            keymapState.matches('settings-protected-file-add', event)
          ) {
            event.preventDefault()
            event.stopPropagation()
            void addPattern()
          }
        }}
      />
    </label>
    <button
      type="submit"
      class="inline-flex items-center gap-2 border border-border px-3 py-2 text-sm hover:bg-elevated disabled:opacity-40"
      disabled={!settingsReady || saving || atCapacity || !candidate.trim()}
      title="Add protected file pattern"
    >
      <CioPlus size={14} />
      Add
    </button>
  </form>
  <div class="mt-3 flex items-center justify-between gap-3">
    <p class="text-xs text-dimmed">
      {PERMANENT_BUNDLED_PI_FILE_PATTERNS.length} permanent · {patterns.length} /
      {MAX_BUNDLED_PI_FILE_PATTERNS} additional
    </p>
    <button
      type="button"
      class="text-xs text-muted hover:text-foreground disabled:opacity-40"
      disabled={!settingsReady || saving}
      onclick={() => void save([...new Set([...patterns, ...DEFAULT_BUNDLED_PI_FILE_PATTERNS])])}
    >
      Restore default entries
    </button>
  </div>
</section>
