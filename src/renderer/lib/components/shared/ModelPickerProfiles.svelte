<script lang="ts">
  import { tick } from 'svelte'
  import { Check, Plus, Trash2, X } from '@lucide/svelte'
  import {
    MAX_MODEL_PROFILES,
    MODEL_PROFILE_NAME_MAX_LENGTH,
    activeModelProfile,
    isUsableModelProfile,
    modelProfileSummary
  } from '$shared/model-profiles'
  import type { ModelProfile, ProviderCatalog, ThreadSettings } from '$shared/types'

  /**
   * The profile rows at the top of the model picker.
   *
   * A profile is the whole shape of a run, so it sits above the model list rather
   * than inside it: applying one replaces the harness, model, thinking level,
   * speed, and permission level at once, which is a different gesture from
   * browsing models. Placing it in the fixed band above the virtualized list also
   * leaves `buildPickerLayout` and the picker's keyboard scrolling untouched.
   *
   * Everything here is presentational. Persistence, the applied-settings maths,
   * and the delete confirmation belong to the composer, which owns the settings it
   * commits; this component only reports intent.
   */
  interface Props {
    /** Saved profiles, in the order the user listed them. */
    profiles: ModelProfile[]
    /** Settings in force, used to tick the profile that is currently live. */
    settings: ThreadSettings
    /** Catalogs, so a row shows the model name rather than a raw id. */
    catalogs: ProviderCatalog[]
    /** True when the user has saved as many profiles as the app allows. */
    atCapacity: boolean
    /** Name a new profile starts from, derived from the current settings. */
    draftName: string
    /** Run the whole preset. */
    onApply: (profile: ModelProfile) => void
    /** Store the current settings under `name`. */
    onSave: (name: string) => void
    /** Ask to delete; the composer confirms before anything is removed. */
    onRequestDelete: (profile: ModelProfile) => void
  }

  let {
    profiles,
    settings,
    catalogs,
    atCapacity,
    draftName,
    onApply,
    onSave,
    onRequestDelete
  }: Props = $props()

  let nameInput = $state<HTMLInputElement>()
  /** True while the save row is showing its name field instead of its label. */
  let naming = $state(false)
  let name = $state('')

  let usable = $derived(profiles.filter(isUsableModelProfile))
  let active = $derived(activeModelProfile(profiles, settings))

  // Nothing to show and nowhere to put a new one: a user who has never saved a
  // profile and cannot save another yet pays no rows at all.
  let visible = $derived(usable.length > 0 || !atCapacity)

  function summaryFor(profile: ModelProfile): string {
    return modelProfileSummary(profile, catalogs)
  }

  function beginNaming(): void {
    if (atCapacity) return
    name = draftName
    naming = true
    // The field only exists once `naming` is set, so the focus has to wait a tick.
    void tick().then(() => {
      nameInput?.focus()
      nameInput?.select()
    })
  }

  function cancelNaming(): void {
    naming = false
    name = ''
  }

  function commitNaming(): void {
    const trimmed = name.trim()
    if (!trimmed) return
    onSave(trimmed)
    cancelNaming()
  }

  function onNameKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitNaming()
      return
    }
    if (event.key === 'Escape') {
      // Stopped so Escape abandons the name field instead of closing the whole
      // picker, which is what the popover's own key handler would otherwise do.
      event.preventDefault()
      event.stopPropagation()
      cancelNaming()
    }
  }
</script>

{#if visible}
  <div class="border-b px-2.5 py-1.5">
    {#if usable.length > 0}
      <div class="px-2 pb-1 text-[0.625rem] font-medium text-dimmed">Profiles</div>
      <ul class="flex flex-col">
        {#each usable as profile (profile.id)}
          {@const isActive = active?.id === profile.id}
          <li class="group flex items-center gap-0.5">
            <button
              type="button"
              class="flex min-w-0 flex-auto items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-elevated"
              title={`Apply the ${profile.name} profile: ${summaryFor(profile)}`}
              aria-pressed={isActive}
              onclick={() => onApply(profile)}
            >
              {#if isActive}
                <Check size={11} class="shrink-0 text-primary" />
              {:else}
                <span class="w-[11px] shrink-0" aria-hidden="true"></span>
              {/if}
              <span class="flex min-w-0 flex-col">
                <span
                  class="truncate text-[0.6875rem] {isActive
                    ? 'font-semibold text-primary'
                    : 'text-foreground'}"
                >
                  {profile.name}
                </span>
                <span class="truncate text-[0.5625rem] text-muted">{summaryFor(profile)}</span>
              </span>
            </button>
            <!--
              Delete only asks. The composer runs the shared confirmation, so a
              profile is never removed by a stray click beside the row that applies
              it. It stays out of the way until the row is pointed at, because the
              picker is dense and a permanently visible trash icon would invite
              exactly that click.
            -->
            <button
              type="button"
              class="flex size-5 shrink-0 items-center justify-center rounded text-dimmed opacity-0 transition-opacity hover:bg-overlay hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
              title={`Delete the ${profile.name} profile`}
              aria-label={`Delete the ${profile.name} profile`}
              onclick={() => onRequestDelete(profile)}
            >
              <Trash2 size={11} />
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if naming}
      <div class="mt-1 flex items-center gap-1">
        <input
          bind:this={nameInput}
          bind:value={name}
          maxlength={MODEL_PROFILE_NAME_MAX_LENGTH}
          type="text"
          class="min-w-0 flex-auto rounded-lg bg-transparent px-2 py-1.5 text-[0.6875rem] text-foreground outline-none ring-1 ring-border"
          placeholder="Profile name"
          aria-label="Profile name"
          onkeydown={onNameKeydown}
        />
        <button
          type="button"
          class="shrink-0 rounded px-1.5 py-1 text-[0.6875rem] text-primary transition-colors hover:bg-elevated disabled:opacity-40"
          title="Save this profile"
          aria-label="Save this profile"
          disabled={!name.trim()}
          onclick={commitNaming}
        >
          Save
        </button>
        <button
          type="button"
          class="flex size-5 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          title="Cancel saving this profile"
          aria-label="Cancel saving this profile"
          onclick={cancelNaming}
        >
          <X size={11} />
        </button>
      </div>
    {:else}
      <button
        type="button"
        class="mt-1 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-50"
        title={atCapacity
          ? `You can save up to ${MAX_MODEL_PROFILES} profiles`
          : 'Save the current harness, model, thinking level, speed, and permissions as a profile'}
        aria-label={atCapacity
          ? `You can save up to ${MAX_MODEL_PROFILES} profiles`
          : 'Save the current model setup as a profile'}
        disabled={atCapacity}
        onclick={beginNaming}
      >
        <Plus size={11} class="shrink-0" />
        <span class="truncate">Save current as a profile</span>
      </button>
    {/if}
  </div>
{/if}
