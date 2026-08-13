<script lang="ts">
  import { AlertDialog } from 'bits-ui'
  import { ShieldQuestion } from '@lucide/svelte'
  import type { RemotePendingStepUpApproval } from '$shared/ipc-contract'

  interface Props {
    approvals: RemotePendingStepUpApproval[]
    busy: boolean
    onApprove: (approvalId: string) => void
    onReject: (approvalId: string) => void
  }

  let { approvals, busy, onApprove, onReject }: Props = $props()

  let current = $derived(approvals[0] ?? null)
  let approving = $state(false)

  function handleApprove(approvalId: string): void {
    approving = true
    onApprove(approvalId)
  }

  function handleOpenChange(open: boolean): void {
    // Any dismissal without an explicit approval rejects the single-use ticket.
    if (!open && !approving && current) onReject(current.approvalId)
    approving = false
  }

  function actionLabel(approval: RemotePendingStepUpApproval | null): string {
    if (!approval) return ''
    return approval.action.replace(/:/g, ' ')
  }

  function formatExpiry(expiresAt: number): string {
    const remaining = Math.max(0, expiresAt - Date.now())
    return `${Math.ceil(remaining / 1_000)}s`
  }
</script>

{#if current}
  <AlertDialog.Root open={true} onOpenChange={handleOpenChange}>
    <AlertDialog.Portal>
      <AlertDialog.Overlay class="fixed inset-0 z-50 bg-overlay/70" />
      <AlertDialog.Content
        class="fixed left-1/2 top-1/2 z-50 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
      >
        <AlertDialog.Title class="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ShieldQuestion size={16} class="text-primary" />
          Approve remote action?
        </AlertDialog.Title>
        <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
          A paired phone is asking to run a high-risk operation. Approve once on this computer to
          let it proceed, or reject to block it.
        </AlertDialog.Description>
        <dl class="mt-3 space-y-1.5 rounded-lg bg-elevated px-3 py-2.5 text-xs">
          <div class="flex justify-between gap-3">
            <dt class="text-dimmed">Action</dt>
            <dd class="font-medium text-foreground">{actionLabel(current)}</dd>
          </div>
          {#if current.resource}
            <div class="flex justify-between gap-3">
              <dt class="text-dimmed">Project</dt>
              <dd class="max-w-56 truncate text-foreground" title={current.resource}>
                {current.resource}
              </dd>
            </div>
          {/if}
          <div class="flex justify-between gap-3">
            <dt class="text-dimmed">Device</dt>
            <dd class="text-foreground">{current.deviceId.slice(0, 12)}…</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-dimmed">Expires</dt>
            <dd class="text-foreground">in {formatExpiry(current.expiresAt)}</dd>
          </div>
        </dl>
        <p class="mt-2 text-[10px] leading-relaxed text-dimmed">
          The approval is single-use and bound to this exact request. It never shares any secrets or
          content with the phone.
        </p>
        <div class="mt-5 flex justify-end gap-2">
          <AlertDialog.Cancel
            class="h-8 cursor-pointer rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
            disabled={busy}
          >
            Reject
          </AlertDialog.Cancel>
          <AlertDialog.Action
            class="h-8 cursor-pointer rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
            disabled={busy}
            onclick={() => handleApprove(current.approvalId)}
          >
            Approve once
          </AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>
{/if}
