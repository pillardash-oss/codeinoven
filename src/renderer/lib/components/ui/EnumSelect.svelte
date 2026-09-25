<script module lang="ts">
  /** One selectable value. `id` is the value the caller receives back. */
  export interface EnumSelectOption<Value extends string = string> {
    id: Value
    label: string
    /** One short line explaining what picking this value means. */
    hint?: string
  }
</script>

<script lang="ts" generics="T extends string">
  /**
   * Single-select enum picker: one value out of a short list, chosen from a
   * dropdown. Composed on the same `bits-ui` dropdown the app's other pickers
   * use, so it reads and behaves like the rest of the app rather than as a
   * native select.
   *
   * Every option may carry a `hint`, shown under its label, which is what makes
   * this useful for a choice the user has to understand (a priority bracket, a
   * delivery channel) instead of only recognise.
   */
  import { Check, ChevronDown } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'

  interface Props {
    options: readonly EnumSelectOption<T>[]
    /** The current value, or null when nothing is chosen yet. */
    value: T | null
    onChange: (id: T) => void
    /** Shown on the trigger when no value is chosen. */
    placeholder: string
    ariaLabel: string
    title: string
    disabled?: boolean
    /** Layout classes for the trigger, e.g. a flex sizing class. */
    class?: string
  }

  let {
    options,
    value,
    onChange,
    placeholder,
    ariaLabel,
    title,
    disabled = false,
    class: className = ''
  }: Props = $props()

  const selected = $derived(options.find((option) => option.id === value) ?? null)
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="flex w-full items-center gap-2 rounded-lg border border-border bg-elevated px-2.5 py-1.5 text-left text-foreground outline-none transition-colors hover:bg-overlay focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 {className}"
    aria-label={ariaLabel}
    {title}
    {disabled}
  >
    <span class="min-w-0 flex-1 truncate text-[0.75rem] {selected ? '' : 'text-dimmed'}">
      {selected?.label ?? placeholder}
    </span>
    <ChevronDown size={13} class="shrink-0 text-dimmed" />
  </DropdownMenu.Trigger>

  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="start"
      sideOffset={6}
      class="z-60 min-w-56 rounded-xl border border-border bg-surface p-1 shadow-lg"
    >
      {#each options as option (option.id)}
        <DropdownMenu.Item
          class="flex items-start gap-2 rounded-md px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-elevated"
          textValue={option.label}
          onSelect={(event) => {
            event.preventDefault()
            onChange(option.id)
          }}
        >
          <span class="min-w-0 flex-1">
            <span class="block truncate text-xs font-medium text-foreground">{option.label}</span>
            {#if option.hint}
              <span class="mt-0.5 block text-[0.625rem] leading-relaxed text-dimmed">
                {option.hint}
              </span>
            {/if}
          </span>
          {#if option.id === value}
            <Check size={12} class="mt-0.5 shrink-0 text-primary" />
          {/if}
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
