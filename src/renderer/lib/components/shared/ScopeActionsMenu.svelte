<script lang="ts">
  import { Ellipsis, Pencil, Trash2 } from '@lucide/svelte'
  import { DEFAULT_SCOPE_BUCKET_ID, type ScopeBucket } from '$shared/types'

  interface Props {
    bucket: ScopeBucket
    onEdit: () => void
    onDelete: () => void
  }

  let { bucket, onEdit, onDelete }: Props = $props()

  let showMenu = $state(false)

  function closeMenu(): void {
    showMenu = false
  }
</script>

<div class="relative shrink-0">
  <button
    class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
    aria-label="Actions for {bucket.name}"
    aria-haspopup="menu"
    aria-expanded={showMenu}
    title="Scope actions"
    onclick={() => (showMenu = !showMenu)}
    oncontextmenu={(e: MouseEvent) => {
      e.preventDefault()
      showMenu = true
    }}
  >
    <Ellipsis size={14} />
  </button>
  {#if showMenu}
    <button
      class="fixed inset-0 z-40 cursor-default"
      aria-label="Close scope actions"
      onclick={closeMenu}
    ></button>
    <div
      class="absolute right-0 top-8 z-50 w-36 overflow-hidden rounded-xl border bg-surface p-1 shadow-lg"
      role="menu"
    >
      <button
        class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-elevated"
        role="menuitem"
        onclick={() => {
          closeMenu()
          onEdit()
        }}
      >
        <Pencil size={13} class="text-muted" />
        Edit
      </button>
      {#if bucket.id !== DEFAULT_SCOPE_BUCKET_ID}
        <button
          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-danger hover:bg-danger/10"
          role="menuitem"
          onclick={() => {
            closeMenu()
            onDelete()
          }}
        >
          <Trash2 size={13} />
          Delete
        </button>
      {/if}
    </div>
  {/if}
</div>
