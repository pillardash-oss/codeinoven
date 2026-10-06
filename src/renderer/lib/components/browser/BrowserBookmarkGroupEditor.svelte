<script lang="ts">
  import { Check, Trash2 } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import AppearancePicker from '$lib/components/shared/AppearancePicker.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { pickAppearanceImage } from '$lib/appearance-image.svelte'
  import { browserBookmarks } from '$lib/stores/browser-bookmarks.svelte'
  import {
    MAX_BROWSER_GROUP_NAME_LENGTH,
    type BrowserAppearance
  } from '$shared/browser/global-browser-tabs'
  import { resolveAppearanceImagePath } from './browser-group-appearance'
  import type { CustomIcon } from '$shared/types'

  interface Props {
    /** The group being edited, or null to create a new one. */
    groupId: string | null
    /** Called with the new group's id right after it is created, so a caller that
     *  opened the editor to file a bookmark can put it there. */
    onCreated?: (groupId: string) => void
    onClose: () => void
  }

  let { groupId, onCreated, onClose }: Props = $props()

  /**
   * One saved-page group's editor.
   *
   * A group is an identity, not a page, so it is edited in a modal rather than the
   * per-row fold the bookmarks themselves use: the fields are the group's own, and
   * there is no row to keep in view while they are read. It carries the same
   * appearance vocabulary a tab group, a box and a project do (a colour, a library
   * icon, a pasted SVG, a picked image), so it draws from the one shared picker
   * instead of growing a second one.
   *
   * Creating and editing are the same surface: with no group the draft starts
   * empty, and with one it starts from the group as the user opened it. Deleting is
   * the group's own destructive half, behind its confirmation, and it never deletes
   * the bookmarks inside it.
   */

  // Read once at construction and never again: the modal is mounted fresh for each
  // edit, so the draft it holds is the group as the user opened it.
  // svelte-ignore state_referenced_locally
  const existing = groupId ? browserBookmarks.groupById(groupId) : null

  let customIcons = $state<CustomIcon[]>([])

  $effect(() => {
    void invoke('icon-library:list').then((icons) => (customIcons = icons))
  })

  async function addCustomIcon(svg: string): Promise<void> {
    const icon = await invoke('icon-library:add', svg)
    customIcons = [...customIcons, icon]
  }

  let name = $state(existing?.name ?? '')
  let color = $state<string | undefined>(existing?.color ?? undefined)
  let iconType = $state<string | undefined>(existing?.iconType ?? undefined)
  let customSvg = $state<string | undefined>(existing?.customSvg ?? undefined)
  let customSvgSelected = $state(false)
  /** Newly picked image, previewed locally until Save persists its path. */
  let pendingIcon = $state<{ path: string; dataUrl: string } | undefined>(undefined)
  let confirmDelete = $state(false)

  const storedImageUrl = $derived(existing ? browserBookmarks.iconUrl(existing.id) : null)
  const previewIconUrl = $derived(pendingIcon?.dataUrl ?? storedImageUrl)
  const hasAppearance = $derived(
    Boolean(color || iconType || customSvg || existing?.imagePath || pendingIcon || storedImageUrl)
  )
  const canSave = $derived(name.trim() !== '')

  async function uploadImage(): Promise<void> {
    // The app-owned copy, not the picked path: this modal persists what it returns.
    const picked = await pickAppearanceImage()
    if (!picked) return
    customSvgSelected = false
    pendingIcon = picked
  }

  function resetAppearance(): void {
    color = existing?.color ?? undefined
    iconType = existing?.iconType ?? undefined
    customSvg = existing?.customSvg ?? undefined
    customSvgSelected = false
    pendingIcon = undefined
  }

  /** Resolve which image path the group should end up with, using the shared rule
   *  the tab group, tab and bookmark editors use so the surfaces cannot drift. */
  function resolveImagePath(): string | null {
    if (!existing) return pendingIcon?.path ?? null
    return resolveAppearanceImagePath({
      currentImagePath: existing.imagePath,
      currentIconType: existing.iconType,
      customSvgSelected,
      customSvg: customSvg ?? null,
      pendingIconPath: pendingIcon?.path ?? null,
      chosenIconType: iconType ?? null
    })
  }

  function save(): void {
    if (!canSave) return
    const appearance: Partial<BrowserAppearance> = {
      color: color ?? null,
      iconType: iconType ?? null,
      customSvg: customSvg ?? null,
      imagePath: resolveImagePath()
    }
    if (existing) {
      browserBookmarks.updateGroup(existing.id, { name, ...appearance })
    } else {
      const id = browserBookmarks.createGroup(name, appearance)
      onCreated?.(id)
    }
    onClose()
  }

  function deleteGroup(): void {
    confirmDelete = false
    if (existing) browserBookmarks.deleteGroup(existing.id)
    onClose()
  }
</script>

<Modal
  open
  title={existing ? 'Edit group' : 'New bookmark group'}
  description="A group folds related bookmarks under a name, a colour and an icon."
  {onClose}
  size="md"
  contentClass="space-y-4 overflow-y-auto p-6"
>
  <AppearancePicker
    {name}
    {color}
    {iconType}
    {customSvg}
    {customIcons}
    onAddCustomIcon={addCustomIcon}
    allowCustomSvg
    resetPlacement="footer"
    fallbackIconUrl={customSvgSelected ? null : previewIconUrl}
    onColorChange={(next) => (color = next)}
    onIconTypeChange={(next) => (iconType = next)}
    onCustomSvgChange={(next) => {
      customSvg = next
      customSvgSelected = Boolean(next)
    }}
    onUploadImage={() => void uploadImage()}
    onReset={resetAppearance}
  />

  <label class="block">
    <span class="mb-1.5 block text-xs font-medium text-muted">Name</span>
    <input
      type="text"
      class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm text-foreground outline-none focus:border-primary"
      placeholder="Reading list"
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

  {#snippet footer()}
    <div class="flex w-full items-center gap-2">
      {#if existing}
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-danger transition-colors hover:bg-danger/10"
          title="Delete this group. Its bookmarks stay saved."
          onclick={() => (confirmDelete = true)}
        >
          <Trash2 size={14} />
          Delete
        </button>
      {/if}
      <div class="ml-auto flex items-center gap-2">
        {#if hasAppearance}
          <button
            type="button"
            class="rounded-lg px-3 py-2 text-sm text-danger transition-colors hover:bg-danger/10"
            title="Reset appearance"
            onclick={resetAppearance}
          >
            Reset
          </button>
        {/if}
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
      {existing?.name ?? 'This group'} is removed. Its bookmarks stay saved and become ungrouped, so no
      page is lost.
    </p>
  </ConfirmDialog>
{/if}
