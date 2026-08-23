<script lang="ts">
  import { tick } from 'svelte'

  interface Props {
    open: boolean
    title?: string
    message?: string
    oncancel: () => void
    onconfirm: () => void | Promise<void>
  }

  let {
    open,
    title = 'Stop Engineering work?',
    message = 'Generated documents and prototype artifacts will be preserved. The active lifecycle run will stop.',
    oncancel,
    onconfirm
  }: Props = $props()
  let confirmButton: HTMLButtonElement | undefined = $state(undefined)

  $effect(() => {
    if (!open) return
    void tick().then(() => confirmButton?.focus())
  })
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-app/70 p-4"
    role="presentation"
  >
    <button
      class="absolute inset-0 cursor-default"
      aria-label="Close confirmation"
      onclick={oncancel}
    ></button>
    <div
      class="relative w-full max-w-md rounded-2xl border bg-surface p-5 shadow-xl"
      role="alertdialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="engineering-cancel-title"
      aria-describedby="engineering-cancel-message"
      onkeydown={(event) => {
        if (event.key === 'Escape') oncancel()
      }}
    >
      <h2 id="engineering-cancel-title" class="text-sm font-semibold text-foreground">{title}</h2>
      <p id="engineering-cancel-message" class="mt-2 text-xs leading-5 text-muted">{message}</p>
      <div class="mt-5 flex justify-end gap-2">
        <button
          type="button"
          class="rounded-lg px-3 py-2 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
          onclick={oncancel}
        >
          Keep running
        </button>
        <button
          bind:this={confirmButton}
          type="button"
          class="rounded-lg bg-danger px-3 py-2 text-xs font-medium text-on-danger transition-opacity hover:opacity-90"
          onclick={() => void onconfirm()}
        >
          Stop work
        </button>
      </div>
    </div>
  </div>
{/if}
