<script lang="ts" generics="Value extends string">
  import CioCheck from 'cio-icon/CioCheck.svelte'
  import CioFilter from 'cio-icon/CioFilter.svelte'
  import { DropdownMenu } from 'bits-ui'

  /**
   * The notification panel's single-section filter menu.
   *
   * A panel tab can carry more narrowings than a sidebar-width row can hold as
   * chips, so the extra one lives behind the filter icon at the end of the row.
   * The option set is supplied by the caller because each narrowing has its own
   * choices; nothing here knows which list it is filtering.
   */
  interface Props {
    value: Value
    options: Array<{ id: Value; label: string; hint?: string }>
    onValueChange: (next: Value) => void
    /** Accessible name of the trigger, e.g. `Filter assistant notifications`. */
    label: string
    /** The active choice, read out after the label in the accessible name. */
    current: string
    /** Whether a non-default choice is active, so the trigger shows it. */
    narrowed: boolean
  }

  let { value, options, onValueChange, label, current, narrowed }: Props = $props()

  const itemClass =
    'flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated'
  const sectionClass =
    'border-b border-border px-2 pt-1.5 pb-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed'

  /** A radio group reports a plain string, so the option list decides whether it
   *  names a choice this menu offers. No cast. */
  function handleValueChange(next: string): void {
    const option = options.find((entry) => entry.id === next)
    if (option) onValueChange(option.id)
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="flex h-6 shrink-0 cursor-pointer items-center gap-1 px-1.5 text-[0.625rem] font-medium transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground {narrowed
      ? 'bg-elevated text-foreground'
      : 'text-muted'}"
    title={label}
    aria-label="{label}, currently {current}"
  >
    <!--
      The icon never changes, so the control does not move around as choices
      change; the tint plus the surface it picks up while narrowed is what says a
      filter is on. A narrowing the reader forgot about is how a list starts
      looking empty for no reason.
    -->
    <CioFilter size={11} class="shrink-0" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="end"
      sideOffset={4}
      collisionPadding={8}
      class="z-50 w-52 overflow-hidden border border-border bg-surface py-1 shadow-xl"
    >
      <p class={sectionClass}>Show</p>
      <DropdownMenu.RadioGroup {value} onValueChange={handleValueChange}>
        {#each options as option (option.id)}
          <DropdownMenu.RadioItem value={option.id} class={itemClass} title={option.hint}>
            <span class="min-w-0 flex-1 truncate">{option.label}</span>
            <CioCheck
              size={12}
              class={['shrink-0', option.id === value ? 'text-primary' : 'invisible']}
              aria-hidden="true"
            />
          </DropdownMenu.RadioItem>
        {/each}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
