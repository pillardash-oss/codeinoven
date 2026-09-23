<script lang="ts">
  import { Check, Plus, Search } from '@lucide/svelte'
  import { Popover } from 'bits-ui'
  import type { UtilityDefinition } from '$shared/types'
  import { utilityKindIcon, utilityKindLabel } from './utility-kind'

  interface Props {
    /** Every utility in the app library. */
    utilities: UtilityDefinition[]
    /** Utilities already connected, rendered as picked rather than addable. */
    connectedIds: ReadonlySet<string>
    disabled?: boolean
    /** Label for the trigger button. */
    label?: string
    onSelect: (utility: UtilityDefinition) => void
  }

  let { utilities, connectedIds, disabled = false, label = 'Add a connection', onSelect }: Props =
    $props()

  let open = $state(false)
  let query = $state('')

  const filtered = $derived.by(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return utilities
    return utilities.filter((utility) =>
      `${utility.name} ${utility.description} ${utility.kind}`.toLowerCase().includes(needle)
    )
  })

  function pick(utility: UtilityDefinition): void {
    if (connectedIds.has(utility.id)) return
    onSelect(utility)
    open = false
    query = ''
  }
</script>

<Popover.Root
  bind:open
  onOpenChange={(next) => {
    if (!next) query = ''
  }}
>
  <Popover.Trigger
    class="flex w-full items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1.5 text-left text-[0.75rem] text-muted transition-colors hover:border-border-strong hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-50"
    {disabled}
    title={label}
    aria-label={label}
  >
    <Plus size={13} strokeWidth={1.8} />
    <span class="truncate">{label}</span>
  </Popover.Trigger>

  <Popover.Portal>
    <Popover.Content
      side="bottom"
      align="start"
      sideOffset={4}
      collisionPadding={12}
      class="z-90 flex w-72 flex-col overflow-hidden rounded-xl border bg-surface shadow-lg"
      role="dialog"
      aria-label="Choose a connection from the utility library"
      tabindex={-1}
      onCloseAutoFocus={(event) => event.preventDefault()}
    >
      <div class="flex items-center gap-1.5 border-b border-border px-2.5 py-2">
        <Search size={12} strokeWidth={1.8} class="shrink-0 text-dimmed" />
        <input
          type="text"
          class="min-w-0 flex-1 bg-transparent text-[0.75rem] text-foreground outline-none placeholder:text-dimmed"
          placeholder="Search the utility library…"
          aria-label="Search the utility library"
          bind:value={query}
        />
      </div>

      <div class="max-h-64 overflow-y-auto p-1">
        {#if filtered.length === 0}
          <p class="px-2 py-3 text-center text-[0.6875rem] text-dimmed">
            {utilities.length === 0 ? 'No utilities installed yet.' : 'No matching utilities.'}
          </p>
        {:else}
          {#each filtered as utility (utility.id)}
            {@const connected = connectedIds.has(utility.id)}
            {@const KindIcon = utilityKindIcon(utility.kind)}
            <button
              type="button"
              class="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors {connected
                ? 'cursor-default opacity-60'
                : 'hover:bg-elevated'}"
              title={connected ? `${utility.name} is already connected` : utility.description}
              aria-label={connected
                ? `${utility.name}, already connected`
                : `Connect ${utility.name}`}
              disabled={connected}
              onclick={() => pick(utility)}
            >
              <span
                class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-elevated text-muted"
              >
                <KindIcon size={12} strokeWidth={1.8} />
              </span>
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-1.5">
                  <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground">
                    {utility.name}
                  </span>
                  <span
                    class="shrink-0 rounded-md bg-elevated px-1.5 py-0.5 text-[0.5625rem] font-medium tracking-wide text-muted uppercase"
                  >
                    {utilityKindLabel(utility.kind)}
                  </span>
                </span>
                {#if utility.description}
                  <span class="mt-0.5 line-clamp-2 block text-[0.625rem] text-dimmed">
                    {utility.description}
                  </span>
                {/if}
              </span>
              {#if connected}
                <Check size={12} strokeWidth={2} class="mt-1 shrink-0 text-primary" />
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
