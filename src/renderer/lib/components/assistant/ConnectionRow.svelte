<script lang="ts">
  import { AlertTriangle, Check, Settings2, X } from '@lucide/svelte'
  import type { RoutineConnection } from '$shared/types'
  import type { ConnectionStatus, ConnectionView } from './assistant-view'
  import { utilityKindIcon, utilityKindLabel } from './utility-kind'

  interface Props {
    view: ConnectionView
    onRemove: (connection: RoutineConnection) => void
    /** Open the Utilities page so a half-configured connection can be supplied. */
    onOpenUtilities: () => void
  }

  let { view, onRemove, onOpenUtilities }: Props = $props()

  const KindIcon = $derived(utilityKindIcon(view.connection.kind ?? view.utility?.kind))

  const STATUS_COLORS: Readonly<Record<ConnectionStatus, string>> = {
    ready: 'var(--color-thread-done)',
    disabled: 'var(--color-dimmed)',
    incomplete: 'var(--color-warning)',
    'needs-setup': 'var(--color-missed)'
  }

  const statusColor = $derived(STATUS_COLORS[view.status])
  const needsSetup = $derived(view.status === 'needs-setup' || view.status === 'incomplete')
</script>

<div class="flex items-start gap-2 rounded-lg border border-border px-2.5 py-2">
  <span
    class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-elevated text-muted"
  >
    <KindIcon size={13} strokeWidth={1.8} />
  </span>

  <div class="min-w-0 flex-1">
    <div class="flex items-center gap-1.5">
      <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground">
        {view.connection.label}
      </span>
      <span
        class="shrink-0 rounded-md bg-elevated px-1.5 py-0.5 text-[0.5625rem] font-medium tracking-wide text-muted uppercase"
      >
        {utilityKindLabel(view.connection.kind ?? view.utility?.kind)}
      </span>
      <span
        class="flex shrink-0 items-center gap-1 text-[0.625rem]"
        style="color: {statusColor}"
        title={view.detail}
      >
        {#if view.status === 'ready'}
          <Check size={11} strokeWidth={2.2} />
          Ready
        {:else}
          <AlertTriangle size={11} strokeWidth={2} />
          {view.status === 'needs-setup'
            ? 'Needs setup'
            : view.status === 'disabled'
              ? 'Off'
              : 'Incomplete'}
        {/if}
      </span>
    </div>
    {#if view.status !== 'ready'}
      <p class="mt-0.5 text-[0.625rem] text-dimmed">{view.detail}</p>
    {/if}
  </div>

  <div class="flex shrink-0 items-center gap-0.5">
    {#if needsSetup || view.status === 'disabled'}
      <button
        type="button"
        class="flex h-6 w-6 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title="Set up {view.connection.label} in Utilities"
        aria-label="Set up {view.connection.label} in Utilities"
        onclick={onOpenUtilities}
      >
        <Settings2 size={12} strokeWidth={1.8} />
      </button>
    {/if}
    <button
      type="button"
      class="flex h-6 w-6 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      title="Remove {view.connection.label} from this routine"
      aria-label="Remove {view.connection.label} from this routine"
      onclick={() => onRemove(view.connection)}
    >
      <X size={12} strokeWidth={1.8} />
    </button>
  </div>
</div>
