<script lang="ts">
  import { Check } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import AppearancePicker from '$lib/components/shared/AppearancePicker.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { MAX_BROWSER_TAB_TITLE_LENGTH, browserTabLabel } from '$lib/stores/global-browser-types'
  import { browserTabIconUrl } from './browser-tab-appearance'
  import { resolveAppearanceImagePath } from './browser-group-appearance'
  import type { CustomIcon } from '$shared/types'

  interface Props {
    /** The tab being edited. The modal is mounted fresh per edit. */
    tabId: string
    onClose: () => void
  }

  let { tabId, onClose }: Props = $props()

  // Read once at construction and never again: the modal is mounted fresh for
  // each edit, so the draft it holds is the tab as the user opened it. If the
  // tab is closed underneath, saving becomes a no-op.
  const existing = globalBrowser.tabs.find((candidate) => candidate.id === tabId) ?? null

  let customIcons = $state<CustomIcon[]>([])

  $effect(() => {
    void invoke('icon-library:list').then((icons) => (customIcons = icons))
  })

  async function addCustomIcon(svg: string): Promise<void> {
    const icon = await invoke('icon-library:add', svg)
    customIcons = [...customIcons, icon]
  }

  /** The label the user typed; blank keeps the page's own title. */
  let title = $state(existing?.customTitle ?? '')
  // The same appearance vocabulary as a project or a browser group: a hex
  // colour, a shared SVG icon key, a pasted SVG, and a picked image file.
  let color = $state<string | undefined>(existing?.color ?? undefined)
  let iconType = $state<string | undefined>(existing?.iconType ?? undefined)
  let customSvg = $state<string | undefined>(existing?.customSvg ?? undefined)
  let customSvgSelected = $state(false)
  /** Newly picked image, previewed locally until Save persists its path. */
  let pendingIcon = $state<{ path: string; dataUrl: string } | undefined>(undefined)
  let pinned = $state(existing?.pinned ?? false)

  const storedIconUrl = $derived(
    existing ? browserTabIconUrl(existing, globalBrowser.tabIconUrl(existing.id)) : null
  )
  const previewIconUrl = $derived(pendingIcon?.dataUrl ?? storedIconUrl)
  const hasAppearance = $derived(
    Boolean(color || iconType || customSvg || existing?.imagePath || pendingIcon || storedIconUrl)
  )
  const pageTitle = $derived(existing ? browserTabLabel(existing) : 'New tab')

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

  function save(): void {
    if (!existing) {
      onClose()
      return
    }
    const imagePath = resolveAppearanceImagePath({
      currentImagePath: existing.imagePath,
      currentIconType: existing.iconType,
      customSvgSelected,
      customSvg: customSvg ?? null,
      pendingIconPath: pendingIcon?.path ?? null,
      chosenIconType: iconType ?? null
    })
    globalBrowser.updateTab(existing.id, {
      customTitle: title.trim().slice(0, MAX_BROWSER_TAB_TITLE_LENGTH) || null,
      color: color ?? null,
      iconType: iconType ?? null,
      customSvg: customSvg ?? null,
      imagePath
    })
    if (pinned !== existing.pinned) globalBrowser.toggleTabPin(existing.id)
    onClose()
  }
</script>

<Modal
  open
  title="Edit tab"
  description="Rename the tab, give it a colour and an icon, or pin it."
  {onClose}
  size="md"
  contentClass="space-y-4 overflow-y-auto p-6"
>
  <AppearancePicker
    name={title.trim() || pageTitle}
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
    <span class="mb-1.5 block text-xs font-medium text-muted">Title</span>
    <input
      type="text"
      class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm text-foreground outline-none focus:border-primary"
      placeholder={pageTitle}
      maxlength={MAX_BROWSER_TAB_TITLE_LENGTH}
      bind:value={title}
      onkeydown={(event: KeyboardEvent) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          save()
        }
      }}
    />
    <span class="mt-1 block text-[0.6875rem] text-dimmed">
      Leave blank to keep the page's own title.
    </span>
  </label>

  <div class="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
    <div class="min-w-0">
      <p class="text-sm text-foreground">Pin tab</p>
      <p class="mt-0.5 text-[0.6875rem] text-dimmed">
        A pinned tab stays at the top and never hibernates.
      </p>
    </div>
    <Switch bind:checked={pinned} title="Pin tab" aria-label="Pin tab" />
  </div>

  {#snippet footer()}
    <div class="flex w-full items-center gap-2">
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
          class="flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
          title="Save this tab"
          onclick={save}
        >
          <Check size={14} />
          Save
        </button>
      </div>
    </div>
  {/snippet}
</Modal>
