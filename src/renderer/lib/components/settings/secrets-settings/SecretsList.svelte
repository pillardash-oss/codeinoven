<script lang="ts">
  import CioKey from '@pdslng/cio-icon/CioKey.svelte'
  import CioLockOpen from '@pdslng/cio-icon/CioLockOpen.svelte'
  import CioShieldAlert from '@pdslng/cio-icon/CioShieldAlert.svelte'
  import { formatDateTimeCompact } from '$shared/date-time-format'
  import { SECRET_SCOPE_ORDER, type SecretInventoryEntry, type SecretScope } from '$shared/secrets'

  /**
   * Every stored secret, grouped by the part of the app that owns it.
   *
   * The list carries no values: a row says what a secret belongs to and when it
   * was written, and the only actions are replacing it and removing it.
   */
  interface Props {
    secrets: readonly SecretInventoryEntry[]
    busy?: boolean
    onRotate: (entry: SecretInventoryEntry) => void
    onDelete: (entry: SecretInventoryEntry) => void
  }

  let { secrets, busy = false, onRotate, onDelete }: Props = $props()

  interface SecretGroup {
    scope: SecretScope
    label: string
    entries: SecretInventoryEntry[]
  }

  const groups = $derived.by((): SecretGroup[] =>
    SECRET_SCOPE_ORDER.flatMap((scope) => {
      const entries = secrets.filter((entry) => entry.scope === scope)
      if (entries.length === 0) return []
      return [{ scope, label: entries[0]?.scopeLabel ?? scope, entries }]
    })
  )
</script>

<div class="space-y-4">
  {#each groups as group (group.scope)}
    <section class="border bg-surface" aria-label={group.label}>
      <div class="flex items-center justify-between border-b px-4 py-2">
        <h2 class="text-xs font-semibold tracking-wide text-dimmed uppercase">{group.label}</h2>
        <span class="text-xs tabular-nums text-dimmed">{group.entries.length}</span>
      </div>
      <div class="divide-y">
        {#each group.entries as entry (entry.ref)}
          <div class="flex items-start gap-3 px-4 py-3">
            <div class="mt-0.5 bg-raised p-1.5 text-muted">
              {#if entry.readable}
                <CioKey size={14} />
              {:else}
                <CioShieldAlert size={14} class="text-danger" />
              {/if}
            </div>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium" title={entry.title}>{entry.title}</p>
              <p class="mt-0.5 truncate text-xs text-muted" title={entry.detail}>
                {entry.detail}
              </p>
              <p
                class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] text-dimmed"
              >
                <span class="tabular-nums">Updated {formatDateTimeCompact(entry.updatedAt)}</span>
                {#if entry.environmentVariable}
                  <span class="font-mono">{entry.environmentVariable}</span>
                {/if}
                {#if !entry.readable}
                  <span class="text-danger">Written by another build, store it again</span>
                {/if}
              </p>
            </div>
            <div class="flex shrink-0 items-center gap-1">
              <button
                type="button"
                class="flex h-8 items-center gap-1.5 border px-2.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
                title="Replace the stored value for {entry.title}"
                aria-label="Replace the stored value for {entry.title}"
                disabled={busy}
                onclick={() => onRotate(entry)}
              >
                <CioLockOpen size={13} />
                Replace
              </button>
              <button
                type="button"
                class="flex h-8 items-center border px-2.5 text-xs text-danger transition-colors hover:bg-danger/10"
                title="Delete the stored value for {entry.title}"
                aria-label="Delete the stored value for {entry.title}"
                disabled={busy}
                onclick={() => onDelete(entry)}
              >
                Delete
              </button>
            </div>
          </div>
        {/each}
      </div>
    </section>
  {/each}
</div>
