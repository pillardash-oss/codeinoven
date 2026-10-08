<script lang="ts">
  import { Check, Trash2 } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import AppearancePicker from '$lib/components/shared/AppearancePicker.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { pickAppearanceImage } from '$lib/appearance-image.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import {
    MAX_BROWSER_GROUP_DESCRIPTION_LENGTH,
    MAX_BROWSER_GROUP_NAME_LENGTH
  } from '$lib/stores/global-browser-types'
  import { resolveAppearanceImagePath } from './browser-group-appearance'
  import type { CustomIcon } from '$shared/types'

  interface Props {
    /** The group being edited, or null to create a new one. */
    groupId: string | null
    onClose: () => void
  }

  let { groupId, onClose }: Props = $props()

  // Read once at construction and never again: the modal is mounted fresh for
  // each edit, so the draft it holds is the group as the user opened it. If the
  // group disappears underneath (deleted elsewhere), saving becomes a no-op.
  // svelte-ignore state_referenced_locally
  const existing = groupId ? globalBrowser.groupById(groupId) : null

  let customIcons = $state<CustomIcon[]>([])

  $effect(() => {
    void invoke('icon-library:list').then((icons) => (customIcons = icons))
  })

  async function addCustomIcon(svg: string): Promise<void> {
    const icon = await invoke('icon-library:add', svg)
    customIcons = [...customIcons, icon]
  }

  let name = $state(existing?.name ?? '')
  let description = $state(existing?.description ?? '')
  let pinned = $state(existing?.pinned ?? false)
  // The same appearance vocabulary as a project or an assistant routine: a hex
  // colour, a shared SVG icon key, a pasted SVG, and a picked image file.
  let color = $state<string | undefined>(existing?.color ?? undefined)
  let iconType = $state<string | undefined>(existing?.iconType ?? undefined)
  let customSvg = $state<string | undefined>(existing?.customSvg ?? undefined)
  let customSvgSelected = $state(false)
  /** Newly picked image, previewed locally until Save persists its path. */
  let pendingIcon = $state<{ path: string; dataUrl: string } | undefined>(undefined)
  let confirmDelete = $state(false)

  const storedImageUrl = $derived(existing ? globalBrowser.groupIconUrl(existing.id) : null)
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

  /** Resolve which image path the group should end up with, using the shared
   *  rule the tab editor also uses so the two cannot drift. */
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
    const appearance = {
      color: color ?? null,
      iconType: iconType ?? null,
      customSvg: customSvg ?? null,
      imagePath: resolveImagePath()
    }
    if (existing) {
      globalBrowser.updateGroup(existing.id, {
        name,
        description,
        pinned,
        ...appearance
      })
    } else {
      const id = globalBrowser.createGroup(name, appearance, description)
      if (pinned) globalBrowser.toggleGroupPin(id)
      void globalBrowser.ensureGroupIconLoaded(id)
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

  <label class="block">
    <span class="mb-1.5 block text-xs font-medium text-muted">Description</span>
    <textarea
      class="min-h-20 w-full resize-y rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
      placeholder="What this group is for"
      maxlength={MAX_BROWSER_GROUP_DESCRIPTION_LENGTH}
      bind:value={description}></textarea>
  </label>

  <div class="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
    <div class="min-w-0">
      <p class="text-sm text-foreground">Pin group</p>
      <p class="mt-0.5 text-[0.6875rem] text-dimmed">
        A pinned group stays at the top of the tab strip.
      </p>
    </div>
    <Switch bind:checked={pinned} title="Pin group" aria-label="Pin group" />
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
      {existing?.name ?? 'This group'} is removed. Its tabs stay open and become ungrouped, so no page
      is closed.
    </p>
  </ConfirmDialog>
{/if}
