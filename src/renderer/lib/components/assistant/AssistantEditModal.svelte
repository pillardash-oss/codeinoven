<script lang="ts">
  import AppearancePicker from '$lib/components/shared/AppearancePicker.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { pickCustomIconImage, type OptimizedCustomIcon } from '$lib/custom-icon-pipeline'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { assistants } from '$lib/stores/assistants.svelte'
  import { assistantIsScheduled, type CustomIcon, type Assistant } from '$shared/types'

  interface Props {
    /** Assistant being edited; null closes the modal. */
    assistant: Assistant | null
    onClose: () => void
    /** Called with the saved assistant so the host can refresh its own snapshot. */
    onSaved?: (assistant: Assistant) => void
  }

  let { assistant, onClose, onSaved }: Props = $props()
  let customIcons = $state<CustomIcon[]>([])

  $effect(() => {
    if (!assistant) return
    void invoke('icon-library:list').then((icons) => (customIcons = icons))
  })

  async function addCustomIcon(svg: string): Promise<void> {
    const icon = await invoke('icon-library:add', svg)
    customIcons = [...customIcons, icon]
  }

  let name = $state('')
  let description = $state('')
  let scheduled = $state(true)
  let color = $state<string | undefined>(undefined)
  let iconType = $state<string | undefined>(undefined)
  let customSvg = $state<string | undefined>(undefined)
  let customSvgSelected = $state(false)
  /** Newly picked icon, previewed locally until Save persists it. */
  let pendingIcon = $state<OptimizedCustomIcon | undefined>(undefined)
  let busy = $state(false)
  let error = $state<string | null>(null)

  // Seed the form each time an assistant is opened, so a previous edit never leaks.
  $effect(() => {
    if (!assistant) return
    name = assistant.name
    description = assistant.description ?? ''
    scheduled = assistantIsScheduled(assistant)
    color = assistant.color
    iconType = assistant.iconType
    customSvg = assistant.customSvg
    customSvgSelected = false
    pendingIcon = undefined
    error = null
  })

  const storedIconUrl = $derived(assistant ? (assistants.iconUrls.get(assistant.id) ?? null) : null)
  const previewIconUrl = $derived(pendingIcon?.dataUrl ?? storedIconUrl)
  const hasAppearance = $derived(
    Boolean(color || iconType || customSvg || assistant?.icon || pendingIcon || storedIconUrl)
  )

  async function uploadImage(): Promise<void> {
    try {
      // The shared pipeline crops, scales and encodes the pick before anything
      // is held, so the preview and the saved icon are the same finished image.
      const picked = await pickCustomIconImage()
      if (!picked) return
      customSvgSelected = false
      pendingIcon = picked
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Could not use that image'
    }
  }

  function resetAppearance(): void {
    color = assistant?.color
    iconType = assistant?.iconType
    customSvg = assistant?.customSvg
    customSvgSelected = false
    pendingIcon = undefined
  }

  async function save(): Promise<void> {
    const target = assistant
    if (!target || !name.trim() || busy) return
    busy = true
    error = null
    try {
      const appearance = {
        name: name.trim(),
        description: description.trim() || null,
        scheduled,
        color: color ?? null,
        iconType: iconType ?? null,
        customSvg: customSvg ?? null
      }
      let saved: Assistant
      if (customSvgSelected && customSvg && target.icon) {
        await assistants.clearAssistantIcon(target.id)
        saved = await assistants.updateAssistant(target.id, appearance)
      } else if (pendingIcon && !customSvgSelected) {
        // Persist the new image, then the appearance the form holds. An image
        // takes precedence over the SVG icon in the preview, but the colour and
        // icon type still save so clearing the image later restores them, and a
        // colour picked in the same session is never dropped.
        await assistants.setAssistantIcon(target.id, pendingIcon.image)
        saved = await assistants.updateAssistant(target.id, appearance)
      } else {
        const hadCustomIcon = Boolean(target.icon)
        const switchingToSvgIcon = iconType !== target.iconType && iconType !== undefined
        if (hadCustomIcon && switchingToSvgIcon) {
          await assistants.clearAssistantIcon(target.id)
        }
        saved = await assistants.updateAssistant(target.id, appearance)
      }
      onSaved?.(saved)
      onClose()
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Could not save the assistant'
      reportError(caught, 'Could not save the assistant')
    } finally {
      busy = false
    }
  }
</script>

<Modal open={assistant !== null} size="lg" title="Edit assistant" {onClose}>
  <form
    id="edit-assistant-form"
    class="space-y-4"
    onsubmit={(event: SubmitEvent) => {
      event.preventDefault()
      void save()
    }}
  >
    {#if assistant}
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
          customSvg = assistant?.customSvg
          customSvgSelected = false
        }}
      />
    {/if}

    <div>
      <label class="mb-1 block text-xs font-medium text-muted" for="edit-assistant-name">
        Assistant name
      </label>
      <input
        id="edit-assistant-name"
        type="text"
        class="w-full border bg-elevated px-3 py-2 text-sm text-foreground placeholder:text-dimmed"
        placeholder="Assistant name"
        bind:value={name}
      />
    </div>

    <div>
      <label class="mb-1 block text-xs font-medium text-muted" for="edit-assistant-description">
        Description <span class="font-normal text-dimmed">(optional)</span>
      </label>
      <textarea
        id="edit-assistant-description"
        rows="2"
        class="w-full resize-none border bg-elevated px-3 py-2 text-sm text-foreground placeholder:text-dimmed"
        placeholder="A note for yourself about what this assistant is for"
        bind:value={description}></textarea>
      <p class="mt-1 text-[0.625rem] leading-relaxed text-dimmed">
        For you only, it is never sent to the agent.
      </p>
    </div>

    <div class="flex items-center justify-between gap-3 border bg-elevated px-3 py-2">
      <div class="min-w-0">
        <p class="text-sm text-foreground">Run on a schedule</p>
        <p class="text-[0.625rem] leading-relaxed text-dimmed">
          {scheduled
            ? 'The assistant fires on its agreed cadence. Turn this off to keep it on demand.'
            : 'No schedule: the assistant runs only when you ask it to. Turning this on clears its saved cadence, so the agent agrees a new one with you.'}
        </p>
      </div>
      <Switch
        bind:checked={scheduled}
        aria-label="Run this assistant on a schedule"
        title="Run on a schedule"
      />
    </div>

    {#if error}
      <p class="border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
    {/if}
  </form>

  {#snippet footer()}
    <div class="flex w-full items-center justify-between">
      {#if hasAppearance}
        <button
          type="button"
          class="px-3 py-2 text-sm text-danger transition-colors hover:bg-danger/10"
          title="Reset appearance"
          onclick={resetAppearance}
        >
          Reset
        </button>
      {:else}<span></span>{/if}
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
          title="Cancel"
          onclick={onClose}
        >
          Cancel
        </button>
        <button
          type="submit"
          form="edit-assistant-form"
          class="bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
          disabled={!name.trim() || busy}
          title="Save assistant settings"
        >
          Save
        </button>
      </div>
    </div>
  {/snippet}
</Modal>
