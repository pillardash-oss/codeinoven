<script lang="ts">
  import { Check, Trash2 } from '@lucide/svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import AppearancePicker from '$lib/components/shared/AppearancePicker.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { pickAppearanceImage } from '$lib/appearance-image.svelte'
  import { browserBookmarks } from '$lib/stores/browser-bookmarks.svelte'
  import {
    MAX_BROWSER_GROUP_NAME_LENGTH,
    type BrowserAppearance
  } from '$shared/browser/global-browser-tabs'
  import type { BrowserBookmarkGroup } from '$shared/browser/browser-library'
  import { resolveAppearanceImagePath } from './browser-group-appearance'
  import type { CustomIcon } from '$shared/types'

  /**
   * The saved-page group editor: the one form for making and changing a group,
   * drawn without a shell of its own.
   *
   * It is embedded twice, on the bookmarks panel's create page and folded open on
   * a group's own row, so both surfaces edit the same fields through one source
   * rather than two forms that drift apart. The panel owns the page, the chevron
   * back and the fold; this component owns the draft, the Save, and the group's
   * destructive half, behind its confirmation. It is the same shape the box editor
   * wears, so making a group reads like making a box.
   */

  interface Props {
    /** The group this editor changes, or null when it is making a new one. */
    group: BrowserBookmarkGroup | null
    /** Called once the group was created or updated. */
    onSaved?: (groupId: string) => void
    /** Called once the group was deleted, so its row can go with it. */
    onDeleted?: () => void
  }

  let { group, onSaved, onDeleted }: Props = $props()

  // Read once at construction: the editor is mounted fresh for each group it opens
  // on, so the draft below is the group as the user opened it and nothing the store
  // does later can overwrite their edits.
  // svelte-ignore state_referenced_locally
  const existing = group

  let customIcons = $state<CustomIcon[]>([])

  $effect(() => {
    void invoke('icon-library:list').then((icons) => (customIcons = icons))
  })

  async function addCustomIcon(svg: string): Promise<void> {
    const icon = await invoke('icon-library:add', svg)
    customIcons = [...customIcons, icon]
  }

  let name = $state(existing?.name ?? '')
  // The same appearance vocabulary as a tab group, a box and a project: a hex
  // colour, a shared SVG icon key, a pasted SVG, and a picked image file.
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
    // The app-owned copy, not the picked path: this editor persists what it returns.
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
   *  the box, tab group and tab editors also use so they cannot drift. */
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
      onSaved?.(existing.id)
      return
    }
    const id = browserBookmarks.createGroup(name, appearance)
    void browserBookmarks.ensureGroupIconLoaded(id)
    onSaved?.(id)
  }

  /** Remove the group. Its pages stay saved and become ungrouped, because losing a
   *  fold must never lose a bookmark. */
  function deleteGroup(): void {
    const target = existing
    if (!target) {
      confirmDelete = false
      return
    }
    browserBookmarks.deleteGroup(target.id)
    confirmDelete = false
    onDeleted?.()
  }

  /** Enter in the name field saves, and Cmd/Ctrl+Enter saves from anywhere in the
   *  editor. The two handlers never overlap, so one save can never fire twice. */
  function onNameFieldKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.metaKey || event.ctrlKey) return
    event.preventDefault()
    save()
  }

  function onEditorKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    save()
  }

  /** The create page's own field takes focus when it opens. An attachment rather
   *  than an action, and a fold on an existing group never steals focus. */
  function focusNameWhenCreating(node: HTMLInputElement): void {
    if (existing) return
    node.focus({ preventScroll: true })
  }
</script>

<!--
  The editor itself is not interactive; its fields and buttons are. The chord sits
  on the container so Cmd/Ctrl+Enter saves from whichever field the user is in.
-->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="space-y-4" onkeydown={onEditorKeydown}>
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
      onkeydown={onNameFieldKeydown}
      {@attach focusNameWhenCreating}
    />
  </label>

  <div class="flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5">
    {#if existing}
      <button
        type="button"
        class="mr-auto flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-danger transition-colors hover:bg-danger/10"
        title="Delete this group. Its bookmarks stay saved."
        onclick={() => (confirmDelete = true)}
      >
        <Trash2 size={13} />
        Delete
      </button>
    {/if}
    {#if hasAppearance}
      <button
        type="button"
        class="rounded-lg px-2.5 py-1.5 text-xs text-danger transition-colors hover:bg-danger/10"
        title="Reset appearance"
        onclick={resetAppearance}
      >
        Reset
      </button>
    {/if}
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
      disabled={!canSave}
      title={existing ? 'Save this group' : 'Create this group'}
      onclick={save}
    >
      <Check size={13} />
      {existing ? 'Save' : 'Create'}
    </button>
  </div>
</div>

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
