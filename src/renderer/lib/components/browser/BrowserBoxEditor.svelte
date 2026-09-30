<script lang="ts">
  import { Check, Trash2 } from '@lucide/svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import AppearancePicker from '$lib/components/shared/AppearancePicker.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import {
    DEFAULT_BOX_ID,
    MAX_BROWSER_BOX_NAME_LENGTH,
    jarIdForBox,
    type GlobalBrowserBox
  } from '$lib/stores/global-browser-types'
  import { resolveAppearanceImagePath } from './browser-group-appearance'
  import type { CustomIcon } from '$shared/types'

  /**
   * The box editor: the one form for making and changing a box, drawn without a
   * shell of its own.
   *
   * It is embedded twice, on the boxes panel's create page and folded open on a
   * box's own row, so both surfaces edit the same fields through one source
   * rather than two forms that drift apart. The panel owns the page, the chevron
   * back and the fold; this component owns the draft, the Save, and the box's
   * destructive halves, each behind its confirmation.
   */

  interface Props {
    /** The box this editor changes, or null when it is making a new one. */
    box: GlobalBrowserBox | null
    /** Called once the box was created or updated. */
    onSaved?: (boxId: string) => void
    /** Called once the box was deleted, so its row can go with it. */
    onDeleted?: () => void
  }

  let { box, onSaved, onDeleted }: Props = $props()

  // Read once at construction: the editor is mounted fresh for each box it opens
  // on, so the draft below is the box as the user opened it and nothing the store
  // does later can overwrite their edits.
  // svelte-ignore state_referenced_locally
  const existing = box
  // The default box is the jar the browser's own pages live in, so it is the one
  // box that cannot be removed; its editor draws no Delete affordance at all.
  const isDefaultBox = existing?.id === DEFAULT_BOX_ID

  let customIcons = $state<CustomIcon[]>([])

  $effect(() => {
    void invoke('icon-library:list').then((icons) => (customIcons = icons))
  })

  async function addCustomIcon(svg: string): Promise<void> {
    const icon = await invoke('icon-library:add', svg)
    customIcons = [...customIcons, icon]
  }

  let name = $state(existing?.name ?? '')
  // The same appearance vocabulary as a group, a project or a routine: a hex
  // colour, a shared SVG icon key, a pasted SVG, and a picked image file.
  let color = $state<string | undefined>(existing?.color ?? undefined)
  let iconType = $state<string | undefined>(existing?.iconType ?? undefined)
  let customSvg = $state<string | undefined>(existing?.customSvg ?? undefined)
  let customSvgSelected = $state(false)
  /** Newly picked image, previewed locally until Save persists its path. */
  let pendingIcon = $state<{ path: string; dataUrl: string } | undefined>(undefined)
  let confirmDelete = $state(false)
  let confirmClear = $state(false)
  /** Whether deleting the box also erases its cookies and site data. On by
   *  default: a box is a jar, so leaving its logins behind is the surprising
   *  choice, and the switch is right there for a user who wants them kept. */
  let eraseData = $state(true)
  let deleting = $state(false)
  let clearing = $state(false)

  /** How many tabs close with the box, so the confirmation can say the cost. */
  const tabCount = $derived(existing ? globalBrowser.tabCountInBox(jarIdForBox(existing.id)) : 0)
  const storedImageUrl = $derived(existing ? globalBrowser.boxIconUrl(existing.id) : null)
  const previewIconUrl = $derived(pendingIcon?.dataUrl ?? storedImageUrl)
  const hasAppearance = $derived(
    Boolean(color || iconType || customSvg || existing?.imagePath || pendingIcon || storedImageUrl)
  )
  const canSave = $derived(name.trim() !== '')

  async function uploadImage(): Promise<void> {
    const imagePath = await invoke('dialog:pickImage')
    if (!imagePath) return
    // Read the file for local preview only; nothing is persisted until Save.
    const dataUrl = await invoke('file:readAsDataUrl', imagePath)
    if (!dataUrl) return
    customSvgSelected = false
    pendingIcon = { path: imagePath, dataUrl }
  }

  function resetAppearance(): void {
    color = existing?.color ?? undefined
    iconType = existing?.iconType ?? undefined
    customSvg = existing?.customSvg ?? undefined
    customSvgSelected = false
    pendingIcon = undefined
  }

  /** Resolve which image path the box should end up with, using the shared rule
   *  the group and tab editors also use so the three cannot drift. */
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
      globalBrowser.updateBox(existing.id, { name, ...appearance })
      onSaved?.(existing.id)
      return
    }
    const id = globalBrowser.createBox(name, appearance)
    void globalBrowser.ensureBoxIconLoaded(id)
    onSaved?.(id)
  }

  async function deleteBox(): Promise<void> {
    const target = existing
    if (!target) {
      confirmDelete = false
      return
    }
    deleting = true
    try {
      // Remove the row first: it closes the box's tabs, so nothing is left
      // holding the partition when the erase below runs. The erase is the forgetting
      // one: the row is gone for good, so its whole profile directory goes with it.
      globalBrowser.deleteBox(target.id)
      if (eraseData) await globalBrowser.forgetBox(target.id)
      confirmDelete = false
      onDeleted?.()
    } finally {
      deleting = false
    }
  }

  /** Erase this box's cookies and site data without deleting the box: the
   *  signed-out reset for a jar the user wants to keep. */
  async function clearData(): Promise<void> {
    const target = existing
    if (!target) {
      confirmClear = false
      return
    }
    clearing = true
    try {
      await globalBrowser.clearBoxData(target.id)
      confirmClear = false
    } finally {
      clearing = false
    }
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
   *  than an action, and a fold on an existing box never steals focus. */
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
      placeholder="Work"
      maxlength={MAX_BROWSER_BOX_NAME_LENGTH}
      bind:value={name}
      onkeydown={onNameFieldKeydown}
      {@attach focusNameWhenCreating}
    />
  </label>

  <div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
    <div class="flex items-center gap-1">
      {#if existing}
        <button
          type="button"
          class="rounded-lg px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-elevated"
          title="Erase this box's cookies and site data, keeping the box"
          onclick={() => (confirmClear = true)}
        >
          Clear data
        </button>
      {/if}
      {#if existing && !isDefaultBox}
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-danger transition-colors hover:bg-danger/10"
          title="Delete this box. Its tabs close."
          onclick={() => (confirmDelete = true)}
        >
          <Trash2 size={13} />
          Delete
        </button>
      {/if}
    </div>
    <div class="flex items-center gap-1">
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
        title={existing ? 'Save this box' : 'Create this box'}
        onclick={save}
      >
        <Check size={13} />
        {existing ? 'Save' : 'Create'}
      </button>
    </div>
  </div>
</div>

{#if confirmClear}
  <ConfirmDialog
    open
    variant="danger"
    title="Clear this box's data?"
    confirmLabel="Clear cookies and data"
    busy={clearing}
    onCancel={() => (confirmClear = false)}
    onConfirm={clearData}
  >
    <p>
      Every sign-in and every stored site preference in {existing?.name ?? 'this box'} is erased, and
      its tabs reload signed out. The box itself stays, and nothing in another box is touched.
    </p>
  </ConfirmDialog>
{/if}

{#if confirmDelete && !isDefaultBox}
  <ConfirmDialog
    open
    variant="danger"
    title="Delete this box?"
    confirmLabel={eraseData ? 'Delete box and data' : 'Delete box'}
    busy={deleting}
    onCancel={() => (confirmDelete = false)}
    onConfirm={deleteBox}
  >
    <p>
      {existing?.name ?? 'This box'} is removed.
      {#if tabCount > 0}
        {tabCount}
        {tabCount === 1 ? 'tab closes' : 'tabs close'} with it, because a tab cannot change boxes in place.
      {/if}
    </p>
    <div class="mt-3 flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
      <div class="min-w-0">
        <p class="text-sm text-foreground">Also erase its cookies and site data</p>
        <p class="mt-0.5 text-[0.6875rem] text-dimmed">
          On, its sign-ins are erased now. Off, they are left on disk, where the next storage
          cleanup reclaims them.
        </p>
      </div>
      <Switch
        bind:checked={eraseData}
        title="Also erase this box's cookies and site data"
        aria-label="Also erase this box's cookies and site data"
      />
    </div>
  </ConfirmDialog>
{/if}
