<script lang="ts">
  import { FolderOpen, LoaderCircle, RotateCcw } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { workRootMoveSummary } from '$lib/design-work-root-summary'
  import {
    DEFAULT_WORK_ROOTS,
    normalizeWorkRoot,
    workRootsConflict,
    type WorkRoots
  } from '$shared/design/work-roots'
  import type { AuthoredWorkKind, WorkRootState } from '$shared/ipc-contract'
  import type { AppConfig, AppConfigPatch } from '$shared/types'

  /**
   * Where designs and videos are saved.
   *
   * `.cio/` is ignored by Git, so work written there is explorable rather than a
   * change to the product. A user who wants their designs reviewed, versioned and
   * deployed alongside the code needs them somewhere the project tracks, and that
   * is a per-project decision about a folder the app has no way to guess. So the
   * folder is a setting, and this card is where it is set.
   *
   * One value covers every project, because the answer is almost always the same
   * shape of path and repeating it per project would be busywork. The consequence
   * is that changing it moves work in every project, which is why the card says so
   * and why it reports what the move did rather than silently succeeding.
   */
  interface Props {
    config: AppConfig
    settingsReady: boolean
    updateConfig: (patch: AppConfigPatch) => Promise<void>
  }

  let { config, settingsReady, updateConfig }: Props = $props()

  /** The row whose save is in flight, so only that row shows a spinner. */
  let busy = $state<AuthoredWorkKind | null>(null)
  let notice = $state('')
  let error = $state('')

  const ROWS: readonly { kind: AuthoredWorkKind; label: string; description: string }[] = [
    {
      kind: 'design',
      label: 'Design folder',
      description: 'Where a design session writes, with one folder per design.'
    },
    {
      kind: 'video',
      label: 'Video folder',
      description: 'Where a video session writes, with one folder per composition.'
    }
  ]

  const configured = $derived(config.workRoots ?? DEFAULT_WORK_ROOTS)
  const disabled = $derived(!settingsReady || busy !== null)

  /**
   * A draft checked before it is stored, so the field can say what is wrong
   * instead of the save failing somewhere the user cannot see.
   *
   * The pair is checked as well as the single value: one root inside the other
   * would make a folder belong to two kinds at once, and the classifier would
   * then answer by an order nobody chose.
   */
  function checkDraft(kind: AuthoredWorkKind, raw: string): { root: string } | { error: string } {
    const root = normalizeWorkRoot(raw)
    if (!root) {
      return {
        error: 'Enter a folder inside the project, such as "designs" or ".cio/designs".'
      }
    }
    const next: WorkRoots =
      kind === 'design'
        ? { design: root, video: configured.video }
        : { design: configured.design, video: root }
    if (workRootsConflict(next)) {
      return {
        error: 'The design and video folders must differ, and neither may sit inside the other.'
      }
    }
    return { root }
  }

  async function applyRoot(kind: AuthoredWorkKind, raw: string): Promise<void> {
    if (disabled) return
    const checked = checkDraft(kind, raw)
    if ('error' in checked) {
      error = checked.error
      notice = ''
      return
    }
    if (checked.root === configured[kind]) {
      error = ''
      notice = ''
      return
    }
    const next: WorkRoots =
      kind === 'design'
        ? { design: checked.root, video: configured.video }
        : { design: configured.design, video: checked.root }
    busy = kind
    error = ''
    notice = ''
    try {
      // Going through the config write rather than a channel of its own is what
      // makes the move happen: main relocates on every save that changes these.
      await updateConfig({ workRoots: next })
      const state: WorkRootState = await invoke('design:workRootState')
      notice = workRootMoveSummary(state, kind)
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'The folder could not be changed.'
    } finally {
      busy = null
    }
  }

  /** Enter and Cmd+Enter both submit the row's form, which is the primary action. */
  function submitRow(kind: AuthoredWorkKind, event: SubmitEvent): void {
    event.preventDefault()
    const form = event.currentTarget
    if (!(form instanceof HTMLFormElement)) return
    const field = form.elements.namedItem(kind)
    if (!(field instanceof HTMLInputElement)) return
    void applyRoot(kind, field.value)
  }
</script>

<section id="settings-block-design-work-folders" class="rounded-xl border bg-surface p-4">
  <h2 class="text-sm font-semibold">Work folders</h2>
  <p class="mt-0.5 text-xs leading-relaxed text-dimmed">
    Where designs and videos are saved, relative to each project. Point a folder at somewhere the
    project tracks to keep the work in version control. Changing one moves what is already saved
    under the old folder, in every project.
  </p>

  {#each ROWS as row (row.kind)}
    <form class="mt-4" onsubmit={(event) => submitRow(row.kind, event)}>
      <label class="flex items-center gap-1.5 text-sm font-medium" for={`work-root-${row.kind}`}>
        <FolderOpen size={13} class="text-dimmed" />
        {row.label}
      </label>
      <p class="mt-0.5 text-xs leading-relaxed text-dimmed">{row.description}</p>
      <div class="mt-2 flex items-center gap-2">
        <input
          id={`work-root-${row.kind}`}
          name={row.kind}
          class="h-9 min-w-0 flex-1 rounded-lg border bg-elevated px-2.5 font-mono text-sm outline-none focus:border-primary disabled:opacity-50"
          value={configured[row.kind]}
          placeholder={DEFAULT_WORK_ROOTS[row.kind]}
          spellcheck="false"
          autocomplete="off"
          {disabled}
          aria-label={`${row.label}, relative to the project root`}
        />
        <button
          type="submit"
          class="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
          {disabled}
          title={`Save the ${row.label.toLowerCase()}`}
        >
          {#if busy === row.kind}
            <LoaderCircle size={12} class="animate-spin" />
          {/if}
          Save
        </button>
        <button
          type="button"
          class="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
          disabled={disabled || configured[row.kind] === DEFAULT_WORK_ROOTS[row.kind]}
          title={`Put new ${row.label.toLowerCase().replace(' folder', 's')} back in ${DEFAULT_WORK_ROOTS[row.kind]}, and move the ones already there`}
          onclick={() => void applyRoot(row.kind, DEFAULT_WORK_ROOTS[row.kind])}
        >
          <RotateCcw size={12} />
          Reset
        </button>
      </div>
      <p class="mt-1 text-xs text-dimmed">
        Default: <code class="font-mono">{DEFAULT_WORK_ROOTS[row.kind]}</code>
      </p>
    </form>
  {/each}

  {#if error !== ''}
    <p class="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</p>
  {:else if notice !== ''}
    <p class="mt-3 rounded-lg bg-elevated px-3 py-2 text-xs text-muted" role="status">{notice}</p>
  {/if}
</section>
