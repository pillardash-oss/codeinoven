import { isCodeInOvenCustomProviderId } from './custom-provider-id'
import { fastSelectionModelId, supportsFastInference } from './fast-inference'
import { resolveDefaultThinkingLevel } from './thinking-presets'
import type {
  InferenceMode,
  ModelProfile,
  PermissionLevel,
  ProviderCatalog,
  ThreadSettings
} from './types'

/**
 * Model profiles, as pure functions.
 *
 * A profile is a named preset that captures a whole run at once: harness,
 * provider, model, thinking level, speed tier, and permission level. The user
 * builds one from the picker instead of re-tuning five separate controls, and
 * applies it the same way.
 *
 * Everything here is pure and store-free so the picker, the composer, and the
 * IPC boundary all read one definition of what a usable profile is and one
 * implementation of the account rule below.
 */

/** Ceiling on saved profiles, so the picker row and the config stay bounded. */
export const MAX_MODEL_PROFILES = 24

/** Longest accepted profile name. */
export const MODEL_PROFILE_NAME_MAX_LENGTH = 48

/** Longest accepted profile id. */
export const MODEL_PROFILE_ID_MAX_LENGTH = 48

const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/u

/** Every speed tier a profile may store, in the order the picker offers them. */
export const MODEL_PROFILE_INFERENCE_MODES: readonly InferenceMode[] = [
  'normal',
  'fast',
  'ultrafast'
]

/** Every permission level a profile may store. */
export const MODEL_PROFILE_PERMISSION_LEVELS: readonly PermissionLevel[] = [
  'auto_review',
  'full_access'
]

/** The label a speed tier reads as in a profile row. */
export const MODEL_PROFILE_INFERENCE_LABELS: Readonly<Record<InferenceMode, string>> = {
  normal: 'Standard',
  fast: 'Fast',
  ultrafast: 'Ultrafast'
}

/**
 * Turn a name into a stable id.
 *
 * The id is what a row is keyed by, so it is derived once from the name the user
 * typed and then kept: a later rename leaves the row's identity alone. A name
 * with nothing sluggable in it becomes `profile` rather than an empty id.
 */
export function modelProfileIdFromLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MODEL_PROFILE_ID_MAX_LENGTH)
    .replace(/-+$/u, '')
  return slug.length > 0 && PROFILE_ID_PATTERN.test(slug) ? slug : 'profile'
}

/** Whether a string is a usable profile id. */
export function isModelProfileId(value: string): boolean {
  return PROFILE_ID_PATTERN.test(value)
}

/**
 * A free id for a new profile named `label`.
 *
 * Two rows may never share an id, so a second `Deep review` becomes
 * `deep-review-2` instead of making the name ambiguous in the picker.
 */
export function uniqueModelProfileId(
  profiles: readonly ModelProfile[] | undefined | null,
  label: string
): string {
  const taken = new Set((profiles ?? []).map((profile) => profile.id))
  const base = modelProfileIdFromLabel(label)
  if (!taken.has(base)) return base
  for (let suffix = 2; suffix <= MAX_MODEL_PROFILES + taken.size; suffix += 1) {
    const candidate = `${base.slice(0, MODEL_PROFILE_ID_MAX_LENGTH - 4)}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base.slice(0, MODEL_PROFILE_ID_MAX_LENGTH - 8)}-${taken.size + 2}`
}

/**
 * Whether a profile names enough to be applied.
 *
 * A profile missing any of harness, provider or model would resolve to somewhere
 * the user never chose, so it is treated as unusable and never offered, rather
 * than being applied to a plausible default.
 */
export function isUsableModelProfile(
  profile: ModelProfile | undefined | null
): profile is ModelProfile {
  return Boolean(
    profile &&
    isModelProfileId(profile.id) &&
    profile.harnessId &&
    profile.providerId &&
    profile.modelId
  )
}

/** Only the profiles that can actually be applied, in the order the user listed them. */
export function usableModelProfiles(
  profiles: readonly ModelProfile[] | undefined | null
): ModelProfile[] {
  return (Array.isArray(profiles) ? profiles : []).filter(isUsableModelProfile)
}

/**
 * The account a profile resolves to.
 *
 * A profile stores no account, so one is chosen at apply time. Staying on the
 * current harness keeps whatever credential the user already selected, because
 * they deliberately chose it and it works for that harness. Crossing harnesses
 * cannot keep it: the account belongs to the harness it was created under and
 * means nothing to the new one, so the target harness's conventional default is
 * used instead. A custom base URL provider carries its credential in the
 * provider record and never takes an account at all.
 */
export function modelProfileAccountId(
  profile: ModelProfile,
  current: Pick<ThreadSettings, 'harnessId' | 'accountId'>
): string | undefined {
  if (isCodeInOvenCustomProviderId(profile.providerId)) return undefined
  if (profile.harnessId === current.harnessId) {
    return current.accountId ?? `${profile.harnessId}.default`
  }
  return `${profile.harnessId}.default`
}

/**
 * The settings a profile applies to, given the catalog it is resolved against.
 *
 * The catalog is only needed so the stored thinking level and speed tier can be
 * checked against what the target model actually offers. A stored value the model
 * cannot run is dropped rather than committed, which is the same rule
 * `withModelSelection` and `normalizeFastInference` apply to a manual switch: a
 * profile written months ago against a model that has since dropped its fast
 * tier must not resurrect a model id that no longer exists.
 */
export function applyModelProfile(
  current: ThreadSettings,
  profile: ModelProfile,
  catalogs: readonly ProviderCatalog[] = []
): ThreadSettings {
  const model = findProfileModel(profile, catalogs)
  // A profile's stored level is the user's own choice, so it wins outright whenever
  // the catalog cannot contradict it. `resolveDefaultThinkingLevel` only reports
  // `undefined` for a model that declares no presets at all, which says nothing
  // about the level; substituting the current level there would silently discard
  // the one field the user explicitly saved.
  const thinkingLevel =
    resolveDefaultThinkingLevel(model?.thinkingPresets, undefined, profile.thinkingLevel) ??
    profile.thinkingLevel
  const inferenceMode = profileInferenceMode(
    profile,
    model?.fastSupported,
    model?.ultrafastSupported
  )
  const modelId =
    inferenceMode === 'fast'
      ? fastSelectionModelId(profile.harnessId, profile.modelId)
      : profile.modelId
  const modelChanged =
    profile.harnessId !== current.harnessId ||
    profile.providerId !== current.providerId ||
    modelId !== current.modelId
  return {
    ...current,
    harnessId: profile.harnessId,
    providerId: profile.providerId,
    modelId,
    accountId: modelProfileAccountId(profile, current),
    thinkingLevel,
    inferenceMode,
    permissionLevel: profile.permissionLevel,
    ...(modelChanged
      ? {
          // An unset window belongs to the harness. Only an explicit choice the new
          // model actually offers is carried over; anything else is dropped so the
          // picker falls back to that model's own window rather than running a
          // budget belonging to the model the user just left.
          contextWindow:
            current.contextWindow !== undefined &&
            model?.contextWindows?.includes(current.contextWindow)
              ? current.contextWindow
              : undefined
        }
      : {})
  }
}

/** The catalog entry for the model a profile names, when the catalog reports one. */
function findProfileModel(
  profile: ModelProfile,
  catalogs: readonly ProviderCatalog[]
): ProviderCatalog['models'][number] | undefined {
  const provider = catalogs.find(
    (candidate) => candidate.harnessId === profile.harnessId && candidate.id === profile.providerId
  )
  return provider?.models.find((candidate) => candidate.id === profile.modelId)
}

/**
 * The speed tier a profile can actually request.
 *
 * Standard always survives. Fast needs a model that exposes a fast tier, and
 * ultrafast is only real on a model that advertises it, so a profile saved
 * against a faster sibling falls back to standard instead of targeting a model
 * id that does not exist.
 */
function profileInferenceMode(
  profile: ModelProfile,
  fastSupported?: boolean,
  ultrafastSupported?: boolean
): InferenceMode {
  if (profile.inferenceMode === 'ultrafast') return ultrafastSupported ? 'ultrafast' : 'normal'
  if (profile.inferenceMode === 'fast') {
    return supportsFastInference(profile.harnessId, profile.providerId, fastSupported)
      ? 'fast'
      : 'normal'
  }
  return 'normal'
}

/**
 * The model id a profile's speed tier resolves to, matching the composer's own
 * fast swap in `withInferenceMode`.
 */
export function modelProfileModelId(profile: ModelProfile): string {
  return profile.inferenceMode === 'fast'
    ? fastSelectionModelId(profile.harnessId, profile.modelId)
    : profile.modelId
}

/**
 * The profile currently in force for these settings, if any.
 *
 * A profile matches on everything it stores, so a row is only ticked once the
 * whole preset is live. Two comparisons are deliberately loose:
 *
 * - The account is ignored. A profile never stores one, and the account resolved
 *   when it was applied can differ from the current one without the preset itself
 *   being different.
 * - The model id matches either the stored id or its fast variant, because that is
 *   what applying a fast profile commits. Comparing the raw ids alone would leave
 *   a fast profile permanently unticked.
 */
export function activeModelProfile(
  profiles: readonly ModelProfile[] | undefined | null,
  settings: Pick<
    ThreadSettings,
    'harnessId' | 'providerId' | 'modelId' | 'thinkingLevel' | 'inferenceMode' | 'permissionLevel'
  >
): ModelProfile | null {
  const inferenceMode = settings.inferenceMode ?? 'normal'
  return (
    usableModelProfiles(profiles).find(
      (profile) =>
        profile.harnessId === settings.harnessId &&
        profile.providerId === settings.providerId &&
        (settings.modelId === profile.modelId ||
          settings.modelId === modelProfileModelId(profile)) &&
        profile.thinkingLevel === settings.thinkingLevel &&
        profile.inferenceMode === inferenceMode &&
        profile.permissionLevel === settings.permissionLevel
    ) ?? null
  )
}

/**
 * One line describing what a profile runs on, for a picker row.
 *
 * The model name is preferred over the raw id because a row reads as a choice
 * the user makes, not as a catalog key they would have to recognise.
 */
export function modelProfileSummary(
  profile: ModelProfile,
  catalogs: readonly ProviderCatalog[] = []
): string {
  const model = findProfileModel(profile, catalogs)
  return [
    model?.name ?? profile.modelId,
    MODEL_PROFILE_INFERENCE_LABELS[profile.inferenceMode] ?? 'Standard',
    profile.thinkingLevel
  ].join(' · ')
}
