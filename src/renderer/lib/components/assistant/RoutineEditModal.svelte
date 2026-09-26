<script lang="ts">
  import AppearancePicker from '$lib/components/shared/AppearancePicker.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { assistantRoutines } from '$lib/stores/assistant-routines.svelte'
  import type { CustomIcon, Routine } from '$shared/types'

  interface Props {
    /** Routine being edited; null closes the modal. */
    routine: Routine | null
    onClose: () => void
    /** Called with the saved routine so the host can refresh its own snapshot. */
    onSaved?: (routine: Routine) => void
  }

  let { routine, onClose, onSaved }: Props = $props()
  let customIcons = $state<CustomIcon[]>([])

  $effect(() => {
    if (!routine) return
    void invoke('icon-library:list').then((icons) => (customIcons = icons))
  })

  async function addCustomIcon(name: string, svg: string): Promise<void> {
    const icon = await invoke('icon-library:add', name, svg)
    customIcons = [...customIcons, icon]
  }

  let name = $state('')
  let description = $state('')
  let color = $state<string | undefined>(undefined)
  let iconType = $state<string | undefined>(undefined)
  let customSvg = $state<string | undefined>(undefined)
  let customSvgSelected = $state(false)
  /** Newly picked image, previewed locally until Save persists it. */
  let pendingIcon = $state<{ path: string; dataUrl: string } | undefined>(undefined)
  let busy = $state(false)
  let error = $state<string | null>(null)

  // Seed the form each time a routine is opened, so a previous edit never leaks.
  $effect(() => {
    if (!routine) return
    name = routine.name
    description = routine.description ?? ''
    color = routine.color
    iconType = routine.iconType
    customSvg = routine.customSvg
    customSvgSelected = false
    pendingIcon = undefined
    error = null
  })

  const storedIconUrl = $derived(
    routine ? (assistantRoutines.iconUrls.get(routine.id) ?? null) : null
  )
  const previewIconUrl = $derived(pendingIcon?.dataUrl ?? storedIconUrl)
  const hasAppearance = $derived(
    Boolean(color || iconType || customSvg || routine?.icon || pendingIcon || storedIconUrl)
  )

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
    color = routine?.color
    iconType = routine?.iconType
    customSvg = routine?.customSvg
    customSvgSelected = false
    pendingIcon = undefined
  }

  async function save(): Promise<void> {
    const target = routine
    if (!target || !name.trim() || busy) return
    busy = true
    error = null
    try {
      const appearance = {
        name: name.trim(),
        description: description.trim() || null,
        color: color ?? null,
        iconType: iconType ?? null,
        customSvg: customSvg ?? null
      }
      let saved: Routine
      if (customSvgSelected && customSvg && target.icon) {
        await assistantRoutines.clearRoutineIcon(target.id)
        saved = await assistantRoutines.updateRoutine(target.id, appearance)
      } else if (pendingIcon && !customSvgSelected) {
        // Persist the new image, then the appearance the form holds. An image
        // takes precedence over the SVG icon in the preview, but the colour and
        // icon type still save so clearing the image later restores them, and a
        // colour picked in the same session is never dropped.
        await assistantRoutines.setRoutineIcon(target.id, pendingIcon.path)
        saved = await assistantRoutines.updateRoutine(target.id, appearance)
      } else {
        const hadCustomIcon = Boolean(target.icon)
        const switchingToSvgIcon = iconType !== target.iconType && iconType !== undefined
        if (hadCustomIcon && switchingToSvgIcon) {
          await assistantRoutines.clearRoutineIcon(target.id)
        }
        saved = await assistantRoutines.updateRoutine(target.id, appearance)
      }
      onSaved?.(saved)
      onClose()
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Could not save the routine'
      reportError(caught, 'Could not save the routine')
    } finally {
      busy = false
    }
  }
</script>

<Modal open={routine !== null} size="lg" title="Edit routine" {onClose}>
  <form
    id="edit-routine-form"
    class="space-y-4"
    onsubmit={(event: SubmitEvent) => {
      event.preventDefault()
      void save()
    }}
  >
    {#if routine}
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
        onReset={() => {
          resetAppearance()
          customSvg = routine?.customSvg
          customSvgSelected = false
        }}
      />
    {/if}

    <div>
      <label class="mb-1 block text-xs font-medium text-muted" for="edit-routine-name">
        Routine name
      </label>
      <input
        id="edit-routine-name"
        type="text"
        class="w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground placeholder:text-dimmed"
        placeholder="Routine name"
        bind:value={name}
      />
    </div>

    <div>
      <label class="mb-1 block text-xs font-medium text-muted" for="edit-routine-description">
        Description <span class="font-normal text-dimmed">(optional)</span>
      </label>
      <textarea
        id="edit-routine-description"
        rows="2"
        class="w-full resize-none rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground placeholder:text-dimmed"
        placeholder="A note for yourself about what this routine is for"
        bind:value={description}></textarea>
      <p class="mt-1 text-[0.625rem] leading-relaxed text-dimmed">
        For you only, it is never sent to the agent.
      </p>
    </div>

    {#if error}
      <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
    {/if}
  </form>

  {#snippet footer()}
    <div class="flex w-full items-center justify-between">
      {#if hasAppearance}
        <button
          type="button"
          class="rounded-lg px-3 py-2 text-sm text-danger transition-colors hover:bg-danger/10"
          title="Reset appearance"
          onclick={resetAppearance}
        >
          Reset
        </button>
      {:else}<span></span>{/if}
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
          title="Cancel"
          onclick={onClose}
        >
          Cancel
        </button>
        <button
          type="submit"
          form="edit-routine-form"
          class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
          disabled={!name.trim() || busy}
          title="Save routine settings"
        >
          Save
        </button>
      </div>
    </div>
  {/snippet}
</Modal>
