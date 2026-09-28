<script lang="ts">
  import { Check, Trash2 } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import {
    BROWSER_GROUP_COLORS,
    MAX_BROWSER_GROUP_NAME_LENGTH,
    browserGroupColor,
    type BrowserGroupIconId
  } from '$lib/stores/global-browser-types'
  import { BROWSER_GROUP_ICON_LIST } from './browser-group-icons'

  interface Props {
    /** The group being edited, or null to create a new one. */
    groupId: string | null
    onClose: () => void
  }

  let { groupId, onClose }: Props = $props()

  // Read once at construction and never again: the panel is mounted fresh for
  // each edit, so the draft it holds is the group as the user opened it. If the
  // group disappears underneath (deleted elsewhere), saving becomes a no-op.
  // svelte-ignore state_referenced_locally
  const existing = groupId ? globalBrowser.groupById(groupId) : null

  let name = $state(existing?.name ?? '')
  let color = $state(existing?.color ?? BROWSER_GROUP_COLORS[0].id)
  let icon = $state<BrowserGroupIconId | null>(existing?.icon ?? null)
  let confirmDelete = $state(false)

  const canSave = $derived(name.trim() !== '')

  function save(): void {
    if (!canSave) return
    if (existing) {
      globalBrowser.updateGroup(existing.id, { name, color, icon })
    } else {
      globalBrowser.createGroup(name, color, icon)
    }
    onClose()
  }

  function deleteGroup(): void {
    confirmDelete = false
    if (existing) globalBrowser.deleteGroup(existing.id)
    onClose()
  }
</script>

<Modal
  open
  title={existing ? 'Edit group' : 'New tab group'}
  description="Groups fold related browser tabs under a name, a colour and an icon."
  {onClose}
  size="md"
  contentClass="space-y-4 overflow-y-auto p-6"
>
  <label class="block">
    <span class="mb-1.5 block text-xs font-medium text-muted">Name</span>
    <input
      type="text"
      class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm text-foreground outline-none focus:border-primary"
      placeholder="Research"
      maxlength={MAX_BROWSER_GROUP_NAME_LENGTH}
      bind:value={name}
      onkeydown={(event: KeyboardEvent) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          save()
        }
      }}
    />
  </label>

  <div>
    <span class="mb-1.5 block text-xs font-medium text-muted">Colour</span>
    <div class="flex flex-wrap gap-2">
      {#each BROWSER_GROUP_COLORS as swatch (swatch.id)}
        <button
          type="button"
          class="flex h-8 w-8 items-center justify-center rounded-lg border transition-colors {color ===
          swatch.id
            ? 'border-primary bg-elevated'
            : 'border-border hover:bg-elevated'}"
          aria-pressed={color === swatch.id}
          aria-label={swatch.label}
          title={swatch.label}
          onclick={() => (color = swatch.id)}
        >
          <span class="h-3.5 w-3.5 rounded-full {swatch.dot}"></span>
        </button>
      {/each}
    </div>
  </div>

  <div>
    <span class="mb-1.5 block text-xs font-medium text-muted">Icon</span>
    <div class="flex flex-wrap gap-2">
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-lg border transition-colors {icon ===
        null
          ? 'border-primary bg-elevated'
          : 'border-border hover:bg-elevated'}"
        aria-pressed={icon === null}
        aria-label="No icon"
        title="No icon"
        onclick={() => (icon = null)}
      >
        <span class="h-1.5 w-1.5 rounded-full bg-dimmed"></span>
      </button>
      {#each BROWSER_GROUP_ICON_LIST as entry (entry.id)}
        <button
          type="button"
          class="flex h-8 w-8 items-center justify-center rounded-lg border transition-colors {icon ===
          entry.id
            ? 'border-primary bg-elevated'
            : 'border-border hover:bg-elevated'}"
          aria-pressed={icon === entry.id}
          aria-label={entry.id}
          title={entry.id}
          onclick={() => (icon = entry.id)}
        >
          <entry.icon size={14} class={browserGroupColor(color).text} />
        </button>
      {/each}
    </div>
  </div>

  {#snippet footer()}
    <div class="flex w-full items-center gap-2">
      {#if existing}
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-danger transition-colors hover:bg-danger/10"
          title="Delete this group. Its tabs stay open."
          onclick={() => (confirmDelete = true)}
        >
          <Trash2 size={14} />
          Delete
        </button>
      {/if}
      <div class="ml-auto flex items-center gap-2">
        <button
          type="button"
          class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
          title="Close without saving"
          onclick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
          disabled={!canSave}
          title={existing ? 'Save this group' : 'Create this group'}
          onclick={save}
        >
          <Check size={14} />
          {existing ? 'Save' : 'Create'}
        </button>
      </div>
    </div>
  {/snippet}
</Modal>

{#if confirmDelete}
  <ConfirmDialog
    open
    variant="danger"
    title="Delete this group?"
    confirmLabel="Delete group"
    onCancel={() => (confirmDelete = false)}
    onConfirm={deleteGroup}
  >
    <p>
      {existing?.name ?? 'This group'} is removed. Its tabs stay open and become ungrouped, so no page
      is closed.
    </p>
  </ConfirmDialog>
{/if}
