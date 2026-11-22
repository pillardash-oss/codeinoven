<script lang="ts">
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioUndo from '@pdslng/cio-icon/CioUndo.svelte'
  import { keymapKeyGroups, type KeymapShortcut } from '$lib/keymap/keymap'

  /**
   * One keymap row: what the shortcut does, when it applies, and the keys it
   * answers to. The keys are the row's control: pressing a key combination
   * starts from here, so the thing being changed is the thing clicked.
   */
  interface Props {
    shortcut: KeymapShortcut
    keys: readonly string[]
    isMac: boolean
    /** True when the user saved a binding that differs from the registry. */
    isOverridden: boolean
    /** True while this row is recording a new combination. */
    capturing: boolean
    /** Why the last recorded press was rejected, or that a modifier awaits a tap. */
    hint?: string | null
    /** Said once after a save, e.g. that the chord is also bound elsewhere. */
    notice?: string | null
    onStartCapture: () => void
    onClear: () => void
    onReset: () => void
  }

  let {
    shortcut,
    keys,
    isMac,
    isOverridden,
    capturing,
    hint = null,
    notice = null,
    onStartCapture,
    onClear,
    onReset
  }: Props = $props()

  const keyGroups = $derived(keymapKeyGroups(keys, isMac))
  const isBound = $derived(keys.length > 0)
</script>

<div class="border border-border bg-surface p-3">
  <div class="flex items-start justify-between gap-4">
    <div class="min-w-0 flex-1">
      <p class="text-sm font-medium text-foreground">{shortcut.label}</p>
      <p class="mt-0.5 text-xs leading-relaxed text-muted">{shortcut.description}</p>
      <p class="mt-1 text-[0.6875rem] text-dimmed">When: {shortcut.scenario}</p>
    </div>
    <div class="flex shrink-0 items-center gap-1 pt-0.5">
      <button
        type="button"
        class="inline-flex min-h-7 items-center gap-1.5 border px-2 py-1 {capturing
          ? 'border-primary bg-primary/5'
          : 'border-border bg-elevated hover:border-primary/60'}"
        title={capturing
          ? 'Press the keys to bind, or Escape to stop'
          : `Change the keys for ${shortcut.label}`}
        aria-label={capturing
          ? `Recording new keys for ${shortcut.label}, press Escape to stop`
          : `Change the keys for ${shortcut.label}`}
        onclick={onStartCapture}
      >
        {#if capturing}
          <span class="font-mono text-[0.6875rem] text-dimmed">Press keys…</span>
        {:else if keyGroups.length === 0}
          <span class="text-[0.6875rem] text-dimmed">Unbound</span>
        {:else}
          {#each keyGroups as group, index (index)}
            <kbd
              class="inline-flex h-6 min-w-6 items-center justify-center border border-border bg-app px-1.5 font-mono text-[0.6875rem] leading-none text-foreground"
            >
              {group}
            </kbd>
            {#if index < keyGroups.length - 1}
              <span class="text-[0.625rem] text-dimmed">/</span>
            {/if}
          {/each}
        {/if}
      </button>
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center border border-border bg-elevated text-muted transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        title={`Unbind ${shortcut.label}`}
        aria-label={`Unbind ${shortcut.label}`}
        disabled={!isBound || capturing}
        onclick={onClear}
      >
        <CioClose size={13} aria-hidden="true" />
      </button>
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center border border-border bg-elevated text-muted transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        title={`Reset ${shortcut.label} to its default keys`}
        aria-label={`Reset ${shortcut.label} to its default keys`}
        disabled={!isOverridden || capturing}
        onclick={onReset}
      >
        <CioUndo size={13} aria-hidden="true" />
      </button>
    </div>
  </div>
  {#if capturing && hint}
    <p class="mt-2 text-[0.6875rem] text-primary">{hint}</p>
  {:else if notice}
    <p class="mt-2 text-[0.6875rem] text-dimmed">{notice}</p>
  {/if}
</div>
