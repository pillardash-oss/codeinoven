<script lang="ts">
  import { Keyboard } from '@lucide/svelte'
  import { KEYMAP, isMacPlatform, keymapKeyGroups } from '$lib/keymap/keymap'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'

  const isMac = isMacPlatform()
  const totalShortcuts = KEYMAP.categories.reduce((total, category) => {
    return total + category.shortcuts.length
  }, 0)
</script>

<div class="p-6 pb-24">
  <div class="mb-6">
    <h1 class="flex items-center gap-2 text-xl font-bold tracking-tight">
      <Keyboard size={18} class="text-muted" />
      Keymap
    </h1>
    <p class="mt-0.5 text-sm text-muted">
      {totalShortcuts} keyboard shortcuts. {isMac ? '⌘' : 'Ctrl'} is the primary modifier ({isMac
        ? '⌘ Command on macOS'
        : 'Ctrl on Windows and Linux'}) and is shown as
      {isMac ? '⌘' : 'Ctrl'} below.
    </p>
  </div>

  {#each KEYMAP.categories as category (category.id)}
    <section class="mb-7">
      <h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
        {category.label}
      </h2>
      <div class="space-y-1.5">
        {#each category.shortcuts as shortcut (shortcut.id)}
          {@const keyGroups = keymapKeyGroups(keymapState.keysFor(shortcut.id), isMac)}
          <div
            class="flex items-start justify-between gap-4 rounded-xl border border-border bg-surface p-3"
          >
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium text-foreground">{shortcut.label}</p>
              <p class="mt-0.5 text-xs leading-relaxed text-muted">{shortcut.description}</p>
              <p class="mt-1 text-[0.6875rem] text-dimmed">When: {shortcut.scenario}</p>
            </div>
            <div class="flex shrink-0 items-center gap-1 pt-0.5">
              {#if keyGroups.length === 0}
                <span class="text-[0.6875rem] text-dimmed">Unbound</span>
              {:else}
                {#each keyGroups as group, index (index)}
                  <kbd
                    class="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-border bg-elevated px-1.5 font-mono text-[0.6875rem] leading-none text-foreground shadow-sm"
                  >
                    {group}
                  </kbd>
                  {#if index < keyGroups.length - 1}
                    <span class="text-[0.625rem] text-dimmed">/</span>
                  {/if}
                {/each}
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </section>
  {/each}
</div>
