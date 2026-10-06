import { invoke } from '$lib/ipc.svelte'
import { reportError } from '$lib/stores/app-errors.svelte'
import { appConfigState } from '$lib/stores/app-config.svelte'
import {
  MAX_MODEL_PROFILES,
  normalizeModelProfileName,
  renameModelProfile,
  uniqueModelProfileId,
  usableModelProfiles,
  type ModelProfileSettings
} from '$shared/model-profiles'
import type { AppConfigPatch, ModelProfile, ProviderCatalog } from '$shared/types'

/**
 * Saved model profiles, as a picker-scoped controller.
 *
 * The profiles themselves live in `AppConfig.modelProfiles` and are mirrored into
 * `appConfigState`, so this controller never keeps its own copy: it reads the
 * mirrored list and persists through `config:update`, which broadcasts
 * `config:changed` and re-syncs the mirror. That is why there is no local array
 * and no separate save path here.
 *
 * One controller per mounted picker, because `pendingDelete` is per-surface UI
 * state: the picker that was asked to delete a row owns the confirmation that
 * follows, and two open pickers must not share one dialog.
 */
export interface ModelProfilesController {
  /** Profiles that can be applied, in the order the user listed them. */
  readonly profiles: ModelProfile[]
  /** True when no more profiles can be saved. */
  readonly atCapacity: boolean
  /** The profile waiting on delete confirmation, if any. */
  readonly pendingDelete: ModelProfile | null
  /** A starting name for a profile saved from the given settings. */
  draftName(settings: ModelProfileSettings, catalogs: readonly ProviderCatalog[]): string
  /** Ask to delete a profile. Nothing is removed until `confirmDelete` runs. */
  requestDelete(profile: ModelProfile): void
  /** Abandon the pending delete. */
  cancelDelete(): void
  /** Remove the pending profile for good. */
  confirmDelete(): Promise<void>
  /** Save the given settings as a new profile under `name`. */
  save(settings: ModelProfileSettings, name: string): Promise<boolean>
  /** Give an existing profile a new name, keeping everything else it stores. */
  rename(profile: ModelProfile, name: string): Promise<boolean>
}

export function createModelProfilesController(): ModelProfilesController {
  let pendingDelete = $state<ModelProfile | null>(null)

  async function persist(next: ModelProfile[], failureMessage: string): Promise<boolean> {
    try {
      await invoke('config:update', { modelProfiles: next } satisfies AppConfigPatch)
      return true
    } catch (error) {
      reportError(error, failureMessage)
      return false
    }
  }

  return {
    get profiles(): ModelProfile[] {
      return usableModelProfiles(appConfigState.modelProfiles)
    },
    get atCapacity(): boolean {
      return this.profiles.length >= MAX_MODEL_PROFILES
    },
    get pendingDelete(): ModelProfile | null {
      return pendingDelete
    },
    draftName: draftProfileName,
    requestDelete(profile: ModelProfile): void {
      pendingDelete = profile
    },
    cancelDelete(): void {
      pendingDelete = null
    },
    async confirmDelete(): Promise<void> {
      const target = pendingDelete
      if (!target) return
      // Cleared before the write: once it resolves the row is already gone, and
      // leaving it set would let a second confirm target a row that no longer
      // exists.
      pendingDelete = null
      await persist(
        appConfigState.modelProfiles.filter((profile) => profile.id !== target.id),
        'The model profile was not deleted.'
      )
    },
    async save(settings: ModelProfileSettings, name: string): Promise<boolean> {
      const trimmed = normalizeModelProfileName(name)
      // A profile with no model names nothing the app could run, so it is refused
      // here rather than stored as a row that applies to a plausible default.
      if (!trimmed || !settings.modelId || this.atCapacity) return false
      const existing = appConfigState.modelProfiles
      const profile: ModelProfile = {
        id: uniqueModelProfileId(existing, trimmed),
        name: trimmed,
        harnessId: settings.harnessId,
        providerId: settings.providerId,
        modelId: settings.modelId,
        thinkingLevel: settings.thinkingLevel,
        inferenceMode: settings.inferenceMode ?? 'normal',
        permissionLevel: settings.permissionLevel
      }
      return persist([...existing, profile], 'The model profile was not saved.')
    },
    async rename(profile: ModelProfile, name: string): Promise<boolean> {
      // Over the raw list, not the usable subset. The panel lists only profiles it
      // can apply, and a write that sent that subset back would drop any stored row
      // the current catalog cannot resolve, deleting it as a side effect of a rename.
      const next = renameModelProfile(appConfigState.modelProfiles, profile.id, name)
      if (!next) return false
      return persist(next, 'The model profile was not renamed.')
    }
  }
}

/**
 * A starting name for a profile saved from the current settings.
 *
 * The model name is what the user recognises this setup by, so it seeds the field
 * instead of a generic "New profile" they would have to overwrite. A model the
 * catalog has not resolved yet falls back to the harness, which still says more
 * than nothing.
 */
function draftProfileName(
  settings: ModelProfileSettings,
  catalogs: readonly ProviderCatalog[]
): string {
  const provider = catalogs.find(
    (candidate) =>
      candidate.harnessId === settings.harnessId && candidate.id === settings.providerId
  )
  const model = provider?.models.find((candidate) => candidate.id === settings.modelId)
  const base = (model?.name ?? settings.modelId ?? settings.harnessId).trim()
  return base.replace(/[^A-Za-z0-9 -]/gu, '').trim() || 'Profile'
}
