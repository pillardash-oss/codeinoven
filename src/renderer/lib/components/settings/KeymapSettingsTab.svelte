<script lang="ts">
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioKeyboard from '@pdslng/cio-icon/CioKeyboard.svelte'
  import CioSearch from '@pdslng/cio-icon/CioSearch.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import KeymapBindingRow from './KeymapBindingRow.svelte'
  import { KEYMAP, formatKeyCombo, isMacPlatform, keymapShortcut } from '$lib/keymap/keymap'
  import { filterKeymapCategories } from '$lib/keymap/keymap-search'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import {
    MODIFIER_TAP_WINDOW_MS,
    capturedKeyTokens,
    eventModifierToken,
    modifierTapTokens
  } from '$lib/keymap/keymap-capture'
  import { findKeymapBindingConflicts, type KeymapConflict } from '$lib/keymap/keymap-conflicts'
  import { showToastError } from '$lib/stores/app-errors.svelte'

  const isMac = isMacPlatform()
  const totalShortcuts = KEYMAP.categories.reduce((total, category) => {
    return total + category.shortcuts.length
  }, 0)

  let query = $state('')
  /** The row currently recording a new combination, if any. */
  let capturingId = $state<string | null>(null)
  /** Why the last press was refused, or which modifier is waiting for its tap. */
  let captureHint = $state<string | null>(null)
  /** One line under a row after it was rebound or had its binding removed. */
  let notices = $state<Record<string, string>>({})
  /** A recorded chord that collides with a shortcut listening at the same time. */
  let pending = $state<{ id: string; keys: string[]; conflicts: KeymapConflict[] } | null>(null)

  /** The bare modifier tap being counted, so two of them can become a gesture. */
  let modifierTap: { token: string; taps: number; at: number } | null = null

  const matchedCategories = $derived(
    filterKeymapCategories(KEYMAP.categories, query, {
      keysFor: (id) => keymapState.keysFor(id),
      isMac
    })
  )
  const matchCount = $derived(
    matchedCategories.reduce((total, category) => total + category.shortcuts.length, 0)
  )
  const isSearching = $derived(query.trim().length > 0)
  const overriddenCount = $derived(Object.keys(keymapState.serialized).length)

  function isOverridden(id: string): boolean {
    return id in keymapState.serialized
  }

  function keysFor(id: string): readonly string[] {
    return keymapState.keysFor(id)
  }

  function stopCapture(): void {
    capturingId = null
    captureHint = null
    modifierTap = null
  }

  function startCapture(id: string): void {
    if (capturingId === id) {
      stopCapture()
      return
    }
    capturingId = id
    captureHint = null
    modifierTap = null
  }

  /** Write one binding, plus the unbinding of every shortcut it replaced. */
  async function saveBinding(
    id: string,
    keys: readonly string[],
    unbind: readonly string[] = [],
    sharedWith: readonly KeymapConflict[] = []
  ): Promise<void> {
    let next = keymapState.withBinding(id, keys)
    for (const replaced of unbind) next = keymapState.withBinding(replaced, [], next)
    const shortcut = keymapShortcut(id)
    try {
      await keymapState.save(next)
    } catch {
      showToastError('That shortcut could not be saved', {
        description: 'The keys are unchanged. Try again in a moment.',
        id: 'keymap-save-failed'
      })
      return
    }
    const saved = keys.length > 0 ? formatKeyCombo(keys, isMac) : 'unbound'
    const shared =
      sharedWith.length > 0
        ? ` It is also bound to ${sharedWith.map((entry) => entry.label).join(', ')} under different conditions, which still works there.`
        : ''
    notices = {
      ...notices,
      [id]: `${shortcut?.label ?? id} is now ${saved}.${shared}`
    }
  }

  /**
   * What one press binds.
   *
   * A key with its modifiers is a chord. A bare modifier binds nothing on its
   * own, so the press is counted and the next tap of the same modifier within
   * the window completes the gesture the registry already uses for dictation
   * and for the double modifier tap.
   */
  function handleCapturedPress(event: KeyboardEvent, id: string): void {
    const modifier = eventModifierToken(event, isMac)
    if (modifier) {
      const now = performance.now()
      const taps =
        modifierTap &&
        modifierTap.token === modifier &&
        now - modifierTap.at <= MODIFIER_TAP_WINDOW_MS
          ? modifierTap.taps + 1
          : 1
      modifierTap = { token: modifier, taps, at: now }
      const tokens = modifierTapTokens(modifier, taps)
      if (tokens) {
        finishCapture(id, tokens)
        return
      }
      captureHint = 'Tap it again to bind it, or press a key with it.'
      return
    }
    modifierTap = null
    const tokens = capturedKeyTokens(event, isMac)
    if (!tokens) {
      captureHint = 'That key cannot be bound. Try a letter, a number, or a key with a modifier.'
      return
    }
    finishCapture(id, tokens)
  }

  function finishCapture(id: string, keys: string[]): void {
    const report = findKeymapBindingConflicts(id, keys, keymapState.overrides)
    stopCapture()
    if (report.conflicts.length > 0) {
      pending = { id, keys, conflicts: report.conflicts }
      return
    }
    void saveBinding(id, keys, [], report.sharedWith)
  }

  /** Own the keyboard while recording, so nothing else reacts to the keys. */
  $effect(() => {
    const id = capturingId
    if (!id) return
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      // A bare Escape stops recording; with a modifier it is a bindable chord,
      // so the registry's many Escape entries can be given a new home too.
      if (
        event.key === 'Escape' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        stopCapture()
        return
      }
      handleCapturedPress(event, id)
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', stopCapture)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', stopCapture)
    }
  })

  function confirmOverwrite(): void {
    const choice = pending
    pending = null
    if (!choice) return
    void saveBinding(
      choice.id,
      choice.keys,
      choice.conflicts.map((conflict) => conflict.id)
    )
  }

  function clearBinding(id: string): void {
    if (capturingId === id) stopCapture()
    void saveBinding(id, [])
  }

  function resetBinding(id: string): void {
    if (capturingId === id) stopCapture()
    void keymapState
      .save(keymapState.reset(id))
      .then(() => {
        notices = {
          ...notices,
          [id]: `${keymapShortcut(id)?.label ?? id} is back on its default keys.`
        }
      })
      .catch(() => {
        showToastError('That shortcut could not be reset', { id: 'keymap-reset-failed' })
      })
  }
</script>

<div class="pb-24">
  <div class="px-6 pt-6">
    <h1 class="flex items-center gap-2 text-xl font-bold tracking-tight">
      <CioKeyboard size={18} class="text-muted" />
      Keymap
    </h1>
    <p class="mt-0.5 text-sm text-muted">
      {#if isSearching}
        {matchCount} of {totalShortcuts} keyboard shortcuts match “{query.trim()}”.
      {:else}
        {totalShortcuts} keyboard shortcuts across the app
        {#if overriddenCount > 0}
          · {overriddenCount} changed by you
        {/if}
      {/if}
    </p>
    <p class="mt-2 text-xs text-dimmed">
      Click a shortcut's keys to record a new combination. A key another shortcut already uses while
      both can run is a conflict, and you are asked before it is overwritten.
    </p>
  </div>

  <!-- Pinned so the field stays reachable while the list scrolls under it. -->
  <div class="sticky top-0 z-20 mt-4 border-b border-border bg-app px-6 pb-3">
    <label class="relative block">
      <span class="sr-only">Search keyboard shortcuts</span>
      <CioSearch
        size={15}
        class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-dimmed"
        aria-hidden="true"
      />
      <input
        type="search"
        bind:value={query}
        placeholder="Search shortcuts by name, action, or keys…"
        class="w-full border bg-surface py-2 pr-8 pl-9 text-sm text-foreground outline-none transition-colors placeholder:text-dimmed focus:border-primary"
      />
      {#if query}
        <button
          type="button"
          class="absolute top-1/2 right-2 flex h-6 w-6 -translate-y-1/2 items-center justify-center text-dimmed hover:bg-overlay hover:text-foreground"
          title="Clear search"
          aria-label="Clear search"
          onclick={() => (query = '')}><CioClose size={13} aria-hidden="true" /></button
        >
      {/if}
    </label>
  </div>

  <div class="px-6 pt-4">
    {#if matchedCategories.length === 0}
      <p class="border border-border bg-surface p-4 text-sm text-muted">
        No shortcuts match “{query.trim()}”. Try a shorter search, or a key name like “command
        palette”.
      </p>
    {:else}
      {#each matchedCategories as category (category.id)}
        <section class="mb-7">
          <h2
            class="mb-2 border-b border-border pb-2 text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase"
          >
            {category.label}
          </h2>
          <div class="space-y-1.5">
            {#each category.shortcuts as shortcut (shortcut.id)}
              <KeymapBindingRow
                {shortcut}
                keys={keysFor(shortcut.id)}
                {isMac}
                isOverridden={isOverridden(shortcut.id)}
                capturing={capturingId === shortcut.id}
                hint={capturingId === shortcut.id ? captureHint : null}
                notice={capturingId === shortcut.id ? null : (notices[shortcut.id] ?? null)}
                onStartCapture={() => startCapture(shortcut.id)}
                onClear={() => clearBinding(shortcut.id)}
                onReset={() => resetBinding(shortcut.id)}
              />
            {/each}
          </div>
        </section>
      {/each}
    {/if}
  </div>
</div>

<ConfirmDialog
  open={pending !== null}
  title="That key is already taken"
  confirmLabel="Overwrite the binding"
  variant="primary"
  onCancel={() => (pending = null)}
  onConfirm={confirmOverwrite}
>
  <p>
    <span class="font-mono text-foreground">
      {pending ? formatKeyCombo(pending.keys, isMac) : ''}
    </span>
    is already bound to shortcuts that can be listening at the same time.
  </p>
  <ul class="mt-3 space-y-2">
    {#each pending?.conflicts ?? [] as conflict (conflict.id)}
      <li class="border border-border bg-surface p-2">
        <p class="text-sm font-medium text-foreground">{conflict.label}</p>
        <p class="mt-0.5 font-mono text-xs text-muted">
          {formatKeyCombo(conflict.keys, isMac)}
        </p>
        <p class="mt-1 text-[0.6875rem] text-dimmed">When: {conflict.scenario}</p>
      </li>
    {/each}
  </ul>
  <p class="mt-3">
    Overwriting unbinds {(pending?.conflicts ?? []).length === 1
      ? 'that shortcut'
      : 'those shortcuts'}. They stay in this list, so you can bind them again later.
  </p>
</ConfirmDialog>
