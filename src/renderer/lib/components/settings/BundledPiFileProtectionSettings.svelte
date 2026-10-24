<script lang="ts">
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import { toast } from 'svelte-sonner'
  import { tick } from 'svelte'
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
  let adding = $state(false)
  let candidateInput = $state<HTMLInputElement>()
  let patternList = $state<HTMLUListElement>()
  const patterns = $derived(bundledPiFilePatterns(config.bundledPiSensitiveFilePatterns))
  const atCapacity = $derived(patterns.length >= MAX_BUNDLED_PI_FILE_PATTERNS)

  async function save(next: string[]): Promise<boolean> {
    saving = true
    try {
      await updateConfig({ bundledPiSensitiveFilePatterns: validateBundledPiFilePatterns(next) })
      return true
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Could not save protected file patterns.'
      )
      return false
    } finally {
      saving = false
    }
  }

  async function openEditor(): Promise<void> {
    adding = true
    candidate = ''
    await tick()
    patternList?.scrollTo({ top: 0 })
    candidateInput?.focus({ preventScroll: true })
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
      const next = validateBundledPiFilePatterns([pattern, ...patterns])
      if (await save(next)) {
        candidate = ''
        adding = false
      }
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
  class="border bg-surface p-4"
  aria-label="Bundled Pi sensitive file protection"
>
  <div class="mb-3 flex items-center justify-between gap-3 border-b border-border pb-2">
    <h3 class="text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase">
      Sensitive files · Bundled Pi only
    </h3>
    <button
      type="button"
      class="inline-flex shrink-0 items-center gap-1.5 border border-border px-2 py-1 text-xs hover:bg-elevated disabled:opacity-40"
      title="Add protected file pattern"
      disabled={!settingsReady || saving || atCapacity || adding}
      onclick={() => void openEditor()}
    >
      <CioPlus size={14} />
      Add
    </button>
  </div>
  <p class="text-xs leading-relaxed text-dimmed">
    Every file tool needs approval, even in Full Access. Secret-tool files stay protected.
  </p>

  <ul
    bind:this={patternList}
    class="mt-3 max-h-80 overflow-y-auto overscroll-contain divide-y divide-border border border-border"
  >
    {#if adding}
      <li class="bg-elevated p-3">
        <form class="space-y-2" onsubmit={submit}>
          <label class="block text-xs text-dimmed">
            New pattern
            <input
              bind:this={candidateInput}
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
          <div class="flex items-center justify-between gap-2">
            <button
              type="button"
              class="border border-border px-3 py-1.5 text-xs hover:bg-surface disabled:opacity-40"
              disabled={saving}
              onclick={() => (adding = false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              class="bg-primary px-3 py-1.5 text-xs text-on-primary disabled:opacity-40"
              disabled={!settingsReady || saving || atCapacity || !candidate.trim()}
            >
              Save
            </button>
          </div>
        </form>
      </li>
    {/if}
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

  <div class="mt-3 flex items-center justify-between gap-3">
    <p class="text-xs text-dimmed" aria-live="polite">
      {patterns.length + PERMANENT_BUNDLED_PI_FILE_PATTERNS.length} entries ·
      {PERMANENT_BUNDLED_PI_FILE_PATTERNS.length} permanent
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
