<script lang="ts">
  import { invoke } from '$lib/ipc.svelte'
  import type { CustomIcon, StickyNoteAppearance } from '$shared/types'
  import AppearancePicker from '$lib/components/shared/AppearancePicker.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import { PROJECT_COLORS } from '$lib/project-colors'

  interface Props {
    open: boolean
    noteId: string
    title: string
    iconType: string | null
    customSvg: string | null
    imagePath: string | null
    imageUrl: string | null
    color: string
    onTitleChange: (value: string) => void
    onIconTypeChange: (value: string | null) => void
    onCustomSvgChange: (value: string | null) => void
    onColorChange: (value: string) => void
    onClose: () => void
    onSave: (appearance: StickyNoteAppearance, imageUrl: string | null) => Promise<void>
  }

  let {
    open,
    noteId,
    title,
    iconType,
    customSvg,
    imagePath: initialImagePath,
    imageUrl,
    color,
    onTitleChange,
    onIconTypeChange,
    onCustomSvgChange,
    onColorChange,
    onClose,
    onSave
  }: Props = $props()

  let customIcons = $state<CustomIcon[]>([])
  let saving = $state(false)
  let error = $state<string | null>(null)
  // svelte-ignore state_referenced_locally
  let imagePath = $state(initialImagePath)
  let pendingImage = $state<{ path: string; dataUrl: string } | null>(null)

  // svelte-ignore state_referenced_locally
  const initialIconType = iconType
  // svelte-ignore state_referenced_locally
  const initialCustomSvg = customSvg
  // svelte-ignore state_referenced_locally
  const initialColor = color

  $effect(() => {
    if (!open) return
    error = null
    void invoke('icon-library:list')
      .then((icons) => (customIcons = icons))
      .catch((reason: unknown) => {
        error = reason instanceof Error ? reason.message : 'Could not load saved icons'
      })
  })

  async function addCustomIcon(svg: string): Promise<void> {
    const icon = await invoke('icon-library:add', svg)
    customIcons = [...customIcons, icon]
  }

  async function uploadImage(): Promise<void> {
    const path = await invoke('dialog:pickImage')
    if (!path) return
    const dataUrl = await invoke('file:readAsDataUrl', path)
    if (!dataUrl) return
    imagePath = path
    pendingImage = { path, dataUrl }
  }

  function resetAppearance(): void {
    imagePath = initialImagePath
    pendingImage = null
    onIconTypeChange(initialIconType)
    onCustomSvgChange(initialCustomSvg)
    onColorChange(initialColor)
  }

  async function save(): Promise<void> {
    if (saving || title.trim() === '') return
    saving = true
    error = null
    try {
      await onSave(
        { title: title.trim(), iconType, customSvg, imagePath, color },
        pendingImage?.dataUrl ?? imageUrl
      )
      onClose()
    } catch (reason) {
      error = reason instanceof Error ? reason.message : 'Could not update this sticky note'
    } finally {
      saving = false
    }
  }
</script>

<Modal open={open} title="Edit sticky note" onClose={onClose} size="lg">
  <div class="space-y-4">
    <div>
      <label class="mb-1 block text-xs font-medium text-muted" for={`sticky-note-title-${noteId}`}>
        Title
      </label>
      <input
        id={`sticky-note-title-${noteId}`}
        class="w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground placeholder:text-dimmed"
        type="text"
        maxlength="120"
        value={title}
        oninput={(event) => onTitleChange(event.currentTarget.value)}
      />
    </div>

    <AppearancePicker
      name={title}
      {color}
      iconType={iconType ?? undefined}
      customSvg={customSvg ?? undefined}
      {customIcons}
      allowCustomSvg
      resetPlacement="footer"
      fallbackIconUrl={pendingImage?.dataUrl ?? (imagePath ? imageUrl : null)}
      onColorChange={(value) => onColorChange(value ?? PROJECT_COLORS[0].value)}
      onIconTypeChange={(value) => {
        onIconTypeChange(value ?? null)
        if (value) {
          imagePath = null
          pendingImage = null
        }
      }}
      onCustomSvgChange={(value) => {
        onCustomSvgChange(value ?? null)
        if (value) {
          imagePath = null
          pendingImage = null
        }
      }}
      onAddCustomIcon={addCustomIcon}
      onUploadImage={() => void uploadImage()}
      onReset={resetAppearance}
    />

    {#if error}
      <p class="text-xs text-danger" role="alert">{error}</p>
    {/if}
  </div>

  {#snippet footer()}
    <div class="flex w-full items-center justify-between">
      <button
        type="button"
        class="rounded-lg px-3 py-2 text-sm text-danger transition-colors hover:bg-danger/10"
        title="Reset note appearance"
        onclick={resetAppearance}
      >
        Reset appearance
      </button>
      <div class="flex items-center gap-2">
        <button
          type="button"
          data-modal-dismiss
          class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
          title="Cancel"
          onclick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          data-modal-primary
          class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          title="Apply sticky note changes"
          disabled={saving || title.trim() === ''}
          onclick={() => void save()}
        >
          {saving ? 'Applying…' : 'Apply'}
        </button>
      </div>
    </div>
  {/snippet}
</Modal>
