<script lang="ts">
  import { Check, Pencil, Plus, Trash2, X } from '@lucide/svelte'
  import { permissionLevelLabel } from '$lib/actions'
  import StatusPill from '$lib/components/ui/StatusPill.svelte'
  import {
    MAX_MODEL_PROFILES,
    MODEL_PROFILE_NAME_MAX_LENGTH,
    activeModelProfile,
    isUsableModelProfile,
    modelProfileDisplay,
    modelProfileSummary,
    type ModelProfileDisplay
  } from '$shared/model-profiles'
  import type { ModelProfile, ProviderCatalog, ThreadSettings } from '$shared/types'
  import ModelPickerVendorIcons from './ModelPickerVendorIcons.svelte'
  import { harnessName } from './model-picker-helpers'

  /**
   * The profiles section of the model picker's side panel.
   *
   * A profile is the whole shape of a run, so it is listed as its own surface
   * rather than inside the model list: applying one replaces the harness, model,
   * thinking level, speed, and permission level at once, which is a different
   * gesture from browsing models.
   *
   * Each row is identified the way the model list identifies a model: by the
   * harness and provider marks, with the text naming what actually runs. Two
   * profiles saved against different harnesses therefore never read alike.
   *
   * The header carries the save action and the count, because saving is the rare
   * gesture: as a row of its own at the bottom it took a row's height from the
   * list on every open.
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
    /** Give an existing profile a new name. */
    onRename: (profile: ModelProfile, name: string) => void
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
    onRename,
    onRequestDelete
  }: Props = $props()

  /**
   * Which name field is open, if any.
   *
   * One value rather than one flag per surface: the field is rendered by a single
   * snippet, so the save row and a row being renamed can never both open one, and
   * there is exactly one draft to commit or abandon.
   */
  type NameEditor = { kind: 'new' } | { kind: 'rename'; profile: ModelProfile }

  let editor = $state<NameEditor | null>(null)
  let name = $state('')

  let usable = $derived(profiles.filter(isUsableModelProfile))
  let active = $derived(activeModelProfile(profiles, settings))

  /** Everything a row names, resolved against the catalog. */
  function displayFor(profile: ModelProfile): ModelProfileDisplay {
    return modelProfileDisplay(profile, catalogs)
  }

  function summaryFor(profile: ModelProfile): string {
    return modelProfileSummary(profile, catalogs)
  }

  /**
   * What hovering a row explains, in the order the row reads: which harness and
   * provider it belongs to (drawn as icons), what runs, and what it is allowed to
   * do. The permission level is spelled out because a profile is the one place a
   * Full Access run can be applied without the composer's own selector saying so.
   */
  function titleFor(profile: ModelProfile, display: ModelProfileDisplay): string {
    const detail = [
      harnessName(profile.harnessId),
      display.providerName,
      display.modelName,
      display.thinkingLabel,
      display.inferenceLabel,
      permissionLevelLabel(profile.permissionLevel)
    ].filter((part): part is string => Boolean(part))
    return `Apply the ${profile.name} profile: ${detail.join(' · ')}`
  }

  function beginNaming(): void {
    if (atCapacity) return
    name = draftName
    editor = { kind: 'new' }
  }

  /**
   * Rename in place, rather than by deleting and saving again.
   *
   * The id is not part of this: a profile keeps its identity across a rename, so
   * only the name the user reads changes.
   */
  function beginRename(profile: ModelProfile): void {
    name = profile.name
    editor = { kind: 'rename', profile }
  }

  /**
   * Focus the name field the moment it appears.
   *
   * An attachment rather than a `bind:this` and a `tick`: the field only exists
   * while a name is being edited, so mounting it is exactly the moment it should
   * take the caret, and its text starts selected so an existing name can be
   * replaced by typing.
   */
  function focusNameField(node: HTMLInputElement): void {
    node.focus()
    node.select()
  }

  function cancelNaming(): void {
    editor = null
    name = ''
  }

  function commitName(): void {
    const trimmed = name.trim()
    if (!trimmed || !editor) return
    if (editor.kind === 'rename') onRename(editor.profile, trimmed)
    else onSave(trimmed)
    cancelNaming()
  }

  /**
   * The words a name field reads as, which differ by what it is naming.
   *
   * The save field describes a profile that does not exist yet, while a rename
   * field names the row it sits in, so a screen reader hears which profile is
   * about to change rather than just that something is being renamed.
   */
  function nameFieldCopy(
    kind: NameEditor['kind'],
    profile?: ModelProfile
  ): {
    label: string
    save: string
    cancel: string
  } {
    if (kind === 'rename') {
      return {
        label: profile ? `New name for the ${profile.name} profile` : 'New profile name',
        save: 'Save the new profile name',
        cancel: 'Cancel renaming this profile'
      }
    }
    return {
      label: 'Profile name',
      save: 'Save this profile',
      cancel: 'Cancel saving this profile'
    }
  }

  function onNameKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitName()
      return
    }
    if (event.key === 'Escape') {
      // Stopped so Escape abandons the name field instead of closing the panel it
      // is rendered in, which is what the panel's own key handler would otherwise do.
      event.preventDefault()
      event.stopPropagation()
      cancelNaming()
    }
  }
</script>

<!--
  The name field, shared by the save row and by any row being renamed.

  Rendered as a snippet so both surfaces commit, abandon, and focus identically;
  a second copy of this markup is how the two would drift apart.
-->
{#snippet nameEditor(kind: NameEditor['kind'], profile?: ModelProfile)}
  {@const copy = nameFieldCopy(kind, profile)}
  <input
    {@attach focusNameField}
    bind:value={name}
    maxlength={MODEL_PROFILE_NAME_MAX_LENGTH}
    type="text"
    class="min-w-0 flex-auto rounded-lg bg-transparent px-2 py-1.5 text-[0.6875rem] text-foreground outline-none ring-1 ring-border"
    placeholder={copy.label}
    aria-label={copy.label}
    onkeydown={onNameKeydown}
  />
  <button
    type="button"
    class="shrink-0 rounded px-1.5 py-1 text-[0.6875rem] text-primary transition-colors hover:bg-elevated disabled:opacity-40"
    title={copy.save}
    aria-label={copy.save}
    disabled={!name.trim()}
    onclick={commitName}
  >
    Save
  </button>
  <button
    type="button"
    class="flex size-5 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
    title={copy.cancel}
    aria-label={copy.cancel}
    onclick={cancelNaming}
  >
    <X size={11} />
  </button>
{/snippet}

<!-- Only the list scrolls: the header and the save field in it stay put however
     many profiles are saved. -->
<div class="flex min-h-0 flex-1 flex-col">
  <div class="flex shrink-0 items-center gap-1.5 px-3 pb-1 pt-2">
    {#if editor?.kind === 'new'}
      <!-- Naming takes the whole header, so the field is never crowded by the
           surface's own label and count. -->
      {@render nameEditor('new')}
    {:else}
      <span class="text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed">
        Profiles
      </span>
      <span class="ml-auto text-[0.5625rem] tabular-nums text-dimmed">
        {usable.length}/{MAX_MODEL_PROFILES}
      </span>
      <button
        type="button"
        class="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.625rem] font-medium text-primary transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-50"
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
        <span>Save</span>
      </button>
    {/if}
  </div>

  {#if usable.length > 0}
    <ul class="min-h-0 flex-1 overflow-y-auto p-1">
      {#each usable as profile (profile.id)}
        {@const isActive = active?.id === profile.id}
        {@const display = displayFor(profile)}
        <li class="group flex items-center gap-0.5">
          {#if editor?.kind === 'rename' && editor.profile.id === profile.id}
            <div class="flex min-w-0 flex-auto items-center gap-1 px-1 py-1">
              <!-- The row keeps its harness and provider marks while it is being
                   renamed, so the field still sits in the row it belongs to. -->
              <span class="flex shrink-0 items-center gap-0.5">
                <ModelPickerVendorIcons
                  harnessId={profile.harnessId}
                  providerName={display.providerName ?? profile.providerId}
                  providerId={profile.providerId}
                />
              </span>
              {@render nameEditor('rename', profile)}
            </div>
          {:else}
            <button
              type="button"
              class={`flex min-w-0 flex-auto items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-elevated ${isActive ? 'bg-elevated' : ''}`}
              title={titleFor(profile, display)}
              aria-pressed={isActive}
              onclick={() => onApply(profile)}
            >
              <span class="flex shrink-0 items-center gap-0.5">
                <ModelPickerVendorIcons
                  harnessId={profile.harnessId}
                  providerName={display.providerName ?? profile.providerId}
                  providerId={profile.providerId}
                />
              </span>
              <span class="flex min-w-0 flex-auto flex-col">
                <span class="flex min-w-0 items-center gap-1">
                  <span
                    class={`truncate text-[0.6875rem] ${
                      isActive ? 'font-semibold text-primary' : 'text-foreground'
                    }`}
                  >
                    {profile.name}
                  </span>
                  {#if profile.permissionLevel === 'full_access'}
                    <!--
                      The one setting a profile can carry that the row would otherwise
                      hide: applying it hands the harness unrestricted permissions.
                    -->
                    <StatusPill tone="warning" title="This profile applies Full Access">
                      Full access
                    </StatusPill>
                  {/if}
                  {#if isActive}
                    <Check
                      size={10}
                      class="ml-auto shrink-0 text-primary"
                      aria-label="Profile in force"
                    />
                  {/if}
                </span>
                <span class="truncate text-[0.5625rem] text-muted">{summaryFor(profile)}</span>
              </span>
            </button>
            <!--
              Both row actions stay out of the way until the row is pointed at,
              because the panel is dense and a permanently visible pair of icons
              would invite a stray click beside the row that applies the profile.
            -->
            <button
              type="button"
              class="flex size-5 shrink-0 items-center justify-center rounded text-dimmed opacity-0 transition-opacity hover:bg-overlay hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
              title={`Rename the ${profile.name} profile`}
              aria-label={`Rename the ${profile.name} profile`}
              onclick={() => beginRename(profile)}
            >
              <Pencil size={11} />
            </button>
            <!--
              Delete only asks. The composer runs the shared confirmation, so a
              profile is never removed by a stray click beside the row that applies
              it.
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
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
