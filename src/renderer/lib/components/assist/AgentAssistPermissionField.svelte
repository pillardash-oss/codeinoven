<script lang="ts">
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioShield from '@pdslng/cio-icon/CioShield.svelte'
  import CioShieldAlert from '@pdslng/cio-icon/CioShieldAlert.svelte'
  import { DropdownMenu } from 'bits-ui'
  import { PERMISSION_LEVELS, permissionLevelLabel } from '$lib/actions'
  import type { PermissionLevel } from '$shared/types'

  /**
   * The permission level the confirmed handoff runs with.
   *
   * It sits beside the model because the two decisions belong together: a model
   * that runs unattended needs the user to know, before pressing the send, how
   * its tool calls are going to be approved. Auto review is what every handoff
   * starts on, so granting more is always a deliberate second choice.
   */
  interface Props {
    value: PermissionLevel
    onSelect: (level: PermissionLevel) => void
  }

  let { value, onSelect }: Props = $props()

  let label = $derived(permissionLevelLabel(value))
  let fullAccess = $derived(value === 'full_access')
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="flex min-h-8 min-w-0 items-center gap-1.5 px-2.5 transition-colors {fullAccess
      ? 'text-warning'
      : 'text-muted hover:text-foreground'}"
    title="Permission level: {label}. Auto review approves each tool call unless it is denied; full access approves everything."
    aria-label="Permission level: {label}"
  >
    {#if fullAccess}
      <CioShieldAlert size={12} strokeWidth={2.75} class="shrink-0" />
    {:else}
      <CioShield size={12} class="shrink-0" />
    {/if}
    <span class="min-w-0 truncate text-[0.6875rem] font-medium whitespace-nowrap">{label}</span>
    <CioChevronDown size={10} class="shrink-0 text-dimmed" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="end"
      sideOffset={6}
      collisionPadding={8}
      class="z-90 w-64 border bg-surface p-1 shadow-lg"
    >
      {#each PERMISSION_LEVELS as level (level.id)}
        <DropdownMenu.Item
          class="flex cursor-pointer items-start gap-2 px-2.5 py-2 outline-none data-highlighted:bg-elevated"
          title={level.description}
          onSelect={() => onSelect(level.id)}
        >
          <span
            class="mt-0.5 shrink-0 {level.id === 'full_access' ? 'text-warning' : 'text-muted'}"
          >
            {#if level.id === 'full_access'}
              <CioShieldAlert size={12} strokeWidth={2.75} />
            {:else}
              <CioShield size={12} />
            {/if}
          </span>
          <span class="min-w-0 flex-1">
            <span
              class="block text-xs {level.id === value
                ? 'font-semibold text-foreground'
                : 'text-foreground'}">{level.label}</span
            >
            <span class="mt-0.5 block text-[0.625rem] leading-relaxed text-dimmed"
              >{level.description}</span
            >
          </span>
          {#if level.id === value}
            <span class="mt-0.5 shrink-0 text-[0.625rem] text-primary">On</span>
          {/if}
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
