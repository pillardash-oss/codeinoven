<script lang="ts">
  import { Check, Trash2 } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import AppearancePicker from '$lib/components/shared/AppearancePicker.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { MAX_BROWSER_BOX_NAME_LENGTH } from '$lib/stores/global-browser-types'
  import { resolveAppearanceImagePath } from './browser-group-appearance'
  import type { CustomIcon } from '$shared/types'

  interface Props {
    /** The box being edited, or null to create a new one. */
    boxId: string | null
    onClose: () => void
  }

  let { boxId, onClose }: Props = $props()

  // Read once at construction and never again: the modal is mounted fresh for
  // each edit, so the draft it holds is the box as the user opened it. If the box
  // disappears underneath (deleted elsewhere), saving becomes a no-op.
  // svelte-ignore state_referenced_locally
  const existing = boxId ? globalBrowser.boxById(boxId) : null

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
  const tabCount = $derived(existing ? globalBrowser.tabCountInBox(existing.id) : 0)
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
    } else {
      const id = globalBrowser.createBox(name, appearance)
      void globalBrowser.ensureBoxIconLoaded(id)
    }
    onClose()
  }

  async function deleteBox(): Promise<void> {
    const box = existing
    if (!box) {
      confirmDelete = false
      onClose()
      return
    }
    deleting = true
    try {
      // Remove the row first: it closes the box's tabs, so nothing is left
      // holding the partition when the erase below runs.
      globalBrowser.deleteBox(box.id)
      if (eraseData) await globalBrowser.clearBoxData(box.id)
      confirmDelete = false
      onClose()
    } finally {
      deleting = false
    }
  }

  /** Erase this box's cookies and site data without deleting the box: the
   *  signed-out reset for a jar the user wants to keep. */
  async function clearData(): Promise<void> {
    const box = existing
    if (!box) {
      confirmClear = false
      return
    }
    clearing = true
    try {
      await globalBrowser.clearBoxData(box.id)
      confirmClear = false
    } finally {
      clearing = false
    }
  }
</script>

<Modal
  open
  title={existing ? 'Edit box' : 'New box'}
  description="A box is its own cookies and site data, so it holds its own sign-ins. Tabs in the same box share them; tabs in different boxes do not."
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
      placeholder="Work"
      maxlength={MAX_BROWSER_BOX_NAME_LENGTH}
      bind:value={name}
      onkeydown={(event: KeyboardEvent) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          save()
        }
      }}
    />
  </label>

  <p
    class="rounded-lg border bg-elevated/50 px-3 py-2.5 text-[0.6875rem] leading-relaxed text-dimmed"
  >
    Sign in to the same site in two boxes to stay signed in as two accounts at once. A tab cannot
    change boxes in place; open it again in the box you want.
  </p>

  {#snippet footer()}
    <div class="flex w-full items-center gap-2">
      {#if existing}
        <button
          type="button"
          class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
          title="Erase this box's cookies and site data, keeping the box"
          onclick={() => (confirmClear = true)}
        >
          Clear data
        </button>
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-danger transition-colors hover:bg-danger/10"
          title="Delete this box. Its tabs close."
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
          title={existing ? 'Save this box' : 'Create this box'}
          onclick={save}
        >
          <Check size={14} />
          {existing ? 'Save' : 'Create'}
        </button>
      </div>
    </div>
  {/snippet}
</Modal>

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

{#if confirmDelete}
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
