<script lang="ts">
  import { Check } from '@lucide/svelte'
  import AppearancePicker from '$lib/components/shared/AppearancePicker.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { pickAppearanceImage } from '$lib/appearance-image.svelte'
  import { pickColorForSeed } from '$lib/project-colors'
  import { browserBookmarks } from '$lib/stores/browser-bookmarks.svelte'
  import {
    MAX_BROWSER_TAB_PAGE_TITLE_LENGTH,
    MAX_BROWSER_TAB_URL_LENGTH
  } from '$shared/browser/global-browser-tabs'
  import { browserBookmarkIconUrl } from './browser-bookmark-appearance'
  import { resolveAppearanceImagePath } from './browser-group-appearance'
  import type { CustomIcon } from '$shared/types'

  interface Props {
    /** The saved page this editor changes. The fold mounts it fresh per edit. */
    bookmarkId: string
    /** Called once the edit landed, so the fold can close. */
    onSaved: () => void
  }

  let { bookmarkId, onSaved }: Props = $props()

  /**
   * The saved page's editor: its title, its address, and its icon.
   *
   * It is embedded in the bookmarks panel as a fold on the bookmark's own row,
   * drawn without a shell of its own, for the same reason the box editor is: an
   * editing surface should not cover the thing it edits. The fold owns the
   * disclosure and this owns the draft, the Save and the one error a refused save
   * reports back.
   *
   * A bookmark is quick access the user keeps, not a page the browser recorded, so
   * everything about it is theirs to change. The address goes back to the store as
   * typed: the store owns what a bookmark's address may be, and this shows the one
   * reason it refused rather than keeping a second copy of that rule.
   *
   * The icon is the exception to a bookmark being the user's: by default it is the
   * page's own favicon, which is why it is not a field here but the preview's
   * fallback. Choosing one replaces it.
   */

  // Read once at construction and never again: the fold mounts the editor fresh
  // for each edit, so the draft it holds is the bookmark as the user opened it. A
  // save against a bookmark removed underneath is a no-op.
  const existing =
    browserBookmarks.bookmarks.find((candidate) => candidate.id === bookmarkId) ?? null

  let customIcons = $state<CustomIcon[]>([])

  $effect(() => {
    void invoke('icon-library:list').then((icons) => (customIcons = icons))
  })

  async function addCustomIcon(svg: string): Promise<void> {
    const icon = await invoke('icon-library:add', svg)
    customIcons = [...customIcons, icon]
  }

  let title = $state(existing?.title ?? '')
  let url = $state(existing?.url ?? '')
  let iconType = $state<string | undefined>(existing?.iconType ?? undefined)
  let customSvg = $state<string | undefined>(existing?.customSvg ?? undefined)
  let customSvgSelected = $state(false)
  /** Newly picked image, previewed locally until Save persists its path. */
  let pendingIcon = $state<{ path: string; dataUrl: string } | undefined>(undefined)
  /** Whether the user asked for the page's own icon back, which drops a stored
   *  image icon as well as the draft. */
  let iconCleared = $state(false)
  /** The one thing wrong with what was typed, as the store explains it. */
  let saveError = $state<string | null>(null)

  const storedIconUrl = $derived(
    existing && !iconCleared
      ? browserBookmarkIconUrl(existing, browserBookmarks.iconUrl(existing.id))
      : null
  )
  /** What the page wears until the user chooses an icon: their own, else the
   *  page's favicon, which is the default this editor exists to show. */
  const previewIconUrl = $derived(
    pendingIcon?.dataUrl ?? storedIconUrl ?? existing?.favicon ?? null
  )
  const hasAppearance = $derived(
    Boolean(iconType || customSvg || pendingIcon || (existing?.imagePath && !iconCleared))
  )

  async function uploadImage(): Promise<void> {
    // The app-owned copy, not the picked path: this editor persists what it returns.
    const picked = await pickAppearanceImage()
    if (!picked) return
    customSvgSelected = false
    iconCleared = false
    pendingIcon = picked
  }

  /** Give the page its own icon back: every icon field comes off, the saved image
   *  included, and the row goes back to the page's favicon. */
  function resetAppearance(): void {
    iconType = undefined
    customSvg = undefined
    customSvgSelected = false
    pendingIcon = undefined
    iconCleared = true
  }

  function save(): void {
    if (!existing) return
    const imagePath = resolveAppearanceImagePath({
      currentImagePath: iconCleared ? null : existing.imagePath,
      currentIconType: existing.iconType,
      customSvgSelected,
      customSvg: customSvg ?? null,
      pendingIconPath: pendingIcon?.path ?? null,
      chosenIconType: iconType ?? null
    })
    const rejected = browserBookmarks.applyEdit(existing.id, {
      title,
      url,
      iconType: iconType ?? null,
      customSvg: customSvg ?? null,
      imagePath
    })
    if (rejected !== null) {
      saveError = rejected
      return
    }
    onSaved()
  }

  /** Enter in either field saves, and Cmd/Ctrl+Enter saves from anywhere in the
   *  editor. The two handlers never overlap, so one save can never fire twice. */
  function onFieldKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.metaKey || event.ctrlKey) return
    event.preventDefault()
    save()
  }

  function onEditorKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    save()
  }
</script>

<!--
  The editor itself is not interactive; its fields and buttons are. The chord sits
  on the container so Cmd/Ctrl+Enter saves from whichever field the user is in.
-->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="space-y-4" onkeydown={onEditorKeydown}>
  <AppearancePicker
    name={title.trim() || (existing?.title ?? '')}
    {iconType}
    {customSvg}
    {customIcons}
    onAddCustomIcon={addCustomIcon}
    allowCustomSvg
    showColor={false}
    resetPlacement="footer"
    tint={existing ? pickColorForSeed(existing.id) : undefined}
    fallbackIconUrl={customSvgSelected ? null : previewIconUrl}
    onIconTypeChange={(next) => {
      iconType = next
      // Choosing a library icon means the icon is that one, so a stored image icon
      // stops being the answer. Deselecting changes nothing on its own.
      iconCleared = next !== undefined
    }}
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
      maxlength={MAX_BROWSER_TAB_PAGE_TITLE_LENGTH}
      spellcheck="false"
      autocomplete="off"
      bind:value={title}
      oninput={() => (saveError = null)}
      onkeydown={onFieldKeydown}
    />
    <span class="mt-1 block text-[0.6875rem] text-dimmed">
      Leave blank to name it after its site.
    </span>
  </label>

  <label class="block">
    <span class="mb-1.5 block text-xs font-medium text-muted">Address</span>
    <input
      type="text"
      class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm text-foreground outline-none focus:border-primary"
      maxlength={MAX_BROWSER_TAB_URL_LENGTH}
      spellcheck="false"
      autocomplete="off"
      bind:value={url}
      oninput={() => (saveError = null)}
      onkeydown={onFieldKeydown}
    />
    <span class="mt-1 block text-[0.6875rem] text-dimmed">
      The page the bookmark opens. Changing it takes the page's own icon with it.
    </span>
  </label>

  {#if saveError}
    <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{saveError}</p>
  {/if}

  <div class="flex items-center justify-end gap-1">
    {#if hasAppearance}
      <button
        type="button"
        class="rounded-lg px-2.5 py-1.5 text-xs text-danger transition-colors hover:bg-danger/10"
        title="Reset the icon to the page's own"
        onclick={resetAppearance}
      >
        Reset
      </button>
    {/if}
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover"
      title="Save this bookmark"
      onclick={save}
    >
      <Check size={13} />
      Save
    </button>
  </div>
</div>
