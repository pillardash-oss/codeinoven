<script lang="ts">
  import CioCheck from '@codeio/icon/CioCheck.svelte'
  import CioLayers from '@codeio/icon/CioLayers.svelte'
  import { DropdownMenu } from 'bits-ui'
  import type { GitHubNotificationGroup } from '$shared/types'

  interface Props {
    group: GitHubNotificationGroup
    onGroupChange: (next: GitHubNotificationGroup) => void
  }

  let { group, onGroupChange }: Props = $props()

  const options: Array<{ id: GitHubNotificationGroup; label: string }> = [
    { id: 'date', label: 'Date' },
    { id: 'repository', label: 'Repository' }
  ]

  const activeLabel = $derived(options.find((option) => option.id === group)?.label ?? 'Date')

  const itemClass =
    'flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated'

  /** A radio group reports a plain string, so the option list decides what it names. */
  function handleChange(value: string): void {
    const next = options.find((option) => option.id === value)
    if (next) onGroupChange(next.id)
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="flex h-6 shrink-0 cursor-pointer items-center gap-1 px-1.5 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
    title="Group notifications by {activeLabel.toLowerCase()}"
    aria-label="Group notifications, currently by {activeLabel.toLowerCase()}"
  >
    <CioLayers size={11} class="shrink-0" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="end"
      sideOffset={4}
      collisionPadding={8}
      class="z-50 w-44 overflow-hidden border border-border bg-surface py-1 shadow-xl"
    >
      <p
        class="px-2 pt-1.5 pb-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed"
      >
        Group by
      </p>
      <DropdownMenu.RadioGroup value={group} onValueChange={handleChange}>
        {#each options as option (option.id)}
          <DropdownMenu.RadioItem value={option.id} class={itemClass}>
            <span class="min-w-0 flex-1 truncate">{option.label}</span>
            <CioCheck
              size={12}
              class={['shrink-0', option.id === group ? 'text-primary' : 'invisible']}
              aria-hidden="true"
            />
          </DropdownMenu.RadioItem>
        {/each}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
