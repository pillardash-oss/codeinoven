<script lang="ts">
  import { ChevronDown } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'

  export type BrainstormNextStep = 'lofi' | 'hifi' | 'prd' | 'spec' | 'implement'

  interface Props {
    busy?: boolean
    onNextStep?: (step: BrainstormNextStep) => void
  }

  let { busy = false, onNextStep }: Props = $props()
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
    disabled={busy || !onNextStep}
    title="Choose what to build next from this Brainstorm"
  >
    {busy ? 'Working…' : 'Next step'}
    <ChevronDown size={13} />
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="end"
      sideOffset={4}
      collisionPadding={8}
      strategy="fixed"
      class="z-50 w-52 rounded-lg border border-border bg-surface p-1 shadow-lg"
    >
      <DropdownMenu.Item
        class="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-elevated"
        title="Prototype a low-fidelity Lo-Fi wireframe direction"
        disabled={busy}
        onSelect={() => onNextStep?.('lofi')}
      >
        <span>Prototype Lo-Fi</span>
      </DropdownMenu.Item>
      <DropdownMenu.Item
        class="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-elevated"
        title="Prototype a single high-fidelity Hi-Fi direction"
        disabled={busy}
        onSelect={() => onNextStep?.('hifi')}
      >
        <span>Prototype Hi-Fi</span>
      </DropdownMenu.Item>
      <DropdownMenu.Item
        class="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-elevated"
        title="Generate the product requirements document from this Brainstorm"
        disabled={busy}
        onSelect={() => onNextStep?.('prd')}
      >
        <span>Generate PRD</span>
      </DropdownMenu.Item>
      <DropdownMenu.Item
        class="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-elevated"
        title="Finalize this Brainstorm and generate an implementation-ready Spec"
        disabled={busy}
        onSelect={() => onNextStep?.('spec')}
      >
        <span>Generate Spec</span>
      </DropdownMenu.Item>
      <DropdownMenu.Item
        class="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-elevated"
        title="Implement directly from this Brainstorm"
        disabled={busy}
        onSelect={() => onNextStep?.('implement')}
      >
        <span>Implement</span>
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
