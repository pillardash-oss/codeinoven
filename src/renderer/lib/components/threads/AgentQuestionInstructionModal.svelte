<script lang="ts">
  import { Check, Copy } from '@lucide/svelte'
  import { copyText } from '$lib/copy-text'
  import Modal from '../ui/Modal.svelte'

  /**
   * Shows the step-by-step instruction attached to one agent answer option.
   *
   * The instruction is text the user must run or paste to produce the answer
   * (a command, a script, an ordered procedure). It lives outside the option's
   * description precisely so it can be copied verbatim instead of transcribed
   * from a wrapped paragraph, so this modal renders it as selectable text and
   * offers a single copy control for the whole block.
   */
  interface Props {
    open: boolean
    /** The option label, used in the title so multi-option questions stay clear. */
    optionLabel: string
    instruction: string
    onClose: () => void
  }

  let { open, optionLabel, instruction, onClose }: Props = $props()

  let copied = $state(false)
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined

  $effect(() => () => clearTimeout(copyResetTimer))

  async function copy(): Promise<void> {
    try {
      await copyText(instruction)
      copied = true
      clearTimeout(copyResetTimer)
      copyResetTimer = setTimeout(() => (copied = false), 1500)
    } catch {
      // Clipboard unavailable   the block stays selectable by hand.
    }
  }
</script>

<Modal {open} {onClose} title="Instruction: {optionLabel}" size="lg">
  <div class="space-y-2">
    <p class="text-xs text-muted">
      Follow this to produce the answer. Select any part you need, or copy the whole instruction.
    </p>
    <pre
      class="max-h-[60dvh] overflow-auto rounded-lg border bg-elevated px-3 py-2.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground select-text">{instruction}</pre>
  </div>

  {#snippet footer()}
    <button
      type="button"
      data-modal-dismiss
      class="rounded-lg border bg-elevated px-3 py-2 text-sm font-medium hover:bg-overlay"
      onclick={onClose}
    >
      Close
    </button>
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-on-primary transition-opacity hover:opacity-90"
      onclick={() => void copy()}
    >
      {#if copied}
        <Check size={14} />
        Copied
      {:else}
        <Copy size={14} />
        Copy instruction
      {/if}
    </button>
  {/snippet}
</Modal>
