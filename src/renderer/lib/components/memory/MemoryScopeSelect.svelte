<script lang="ts">
  import { Check, ChevronDown } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import { orderMemoryScopes } from '$shared/memory/memory-scopes'
  import type { MemoryScope } from '$shared/types'
  import type { MemoryScopeOption } from './memory-routing'

  interface Props {
    scopes: readonly MemoryScope[]
    options: readonly MemoryScopeOption[]
    onScopesChange: (scopes: MemoryScope[]) => void
    /** Caption shown when nothing is selected. */
    allLabel?: string
    disabled?: boolean
    ariaLabel: string
    title: string
    class?: string
  }

  let {
    scopes,
    options,
    onScopesChange,
    allLabel = 'All audiences',
    disabled = false,
    ariaLabel,
    title,
    class: className = ''
  }: Props = $props()

  let selectedSet = $derived(new Set(scopes))
  let selectedOptions = $derived(options.filter((option) => selectedSet.has(option.value)))
  let triggerLabel = $derived(
    selectedOptions.length === 0
      ? allLabel
      : selectedOptions.map((option) => option.label).join(' + ')
  )

  function chooseAll(): void {
    onScopesChange([])
  }

  /**
   * A place inside an audience is exclusive: picking it replaces whatever
   * audience toggles were on. An audience is additive, so a user can say
   * "projects and chats" without leaving the dropdown.
   */
  function chooseOption(option: MemoryScopeOption): void {
    if (option.located) {
      onScopesChange([option.value])
      return
    }
    onScopesChange(
      orderMemoryScopes(
        selectedSet.has(option.value)
          ? scopes.filter((scope) => scope !== option.value)
          : [...scopes, option.value]
      )
    )
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="flex w-full items-center gap-2 rounded-lg border bg-elevated px-2.5 py-1.5 text-left text-sm text-foreground outline-none transition-colors hover:bg-overlay focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 {className}"
    aria-label={ariaLabel}
    {title}
    {disabled}
  >
    <span class="min-w-0 flex-1 truncate">{triggerLabel}</span>
    <ChevronDown size={14} class="shrink-0 text-dimmed" />
  </DropdownMenu.Trigger>

  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="start"
      sideOffset={6}
      class="z-60 min-w-56 rounded-xl border border-border bg-surface p-1 shadow-lg"
    >
      <DropdownMenu.Item
        class="flex items-center gap-2 rounded-md px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-elevated"
        textValue={allLabel}
        onSelect={(event) => {
          event.preventDefault()
          chooseAll()
        }}
      >
        <span class="min-w-0 flex-1 truncate text-xs font-medium">{allLabel}</span>
        {#if scopes.length === 0}
          <Check size={12} class="shrink-0 text-primary" />
        {/if}
      </DropdownMenu.Item>
      <div class="mx-1 my-1 border-t border-border" aria-hidden="true"></div>

      {#each options as option (option.value)}
        <DropdownMenu.Item
          class="flex items-center gap-2 rounded-md px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-elevated"
          textValue={option.label}
          onSelect={(event) => {
            event.preventDefault()
            chooseOption(option)
          }}
        >
          <span class="min-w-0 flex-1 truncate text-xs font-medium">{option.label}</span>
          {#if selectedSet.has(option.value)}
            <Check size={12} class="shrink-0 text-primary" />
          {/if}
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
