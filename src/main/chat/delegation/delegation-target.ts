import type {
  HarnessAccount,
  InferenceMode,
  PermissionLevel,
  ProviderCatalog,
  ProviderModel,
  ThinkingLevel,
  ThreadSettings
} from '../../../lib/types'
import type { Oven, OvenHarnessInventoryItem, OvenState } from '../../../lib/ovens'
import { isRemoteOvenId, LOCAL_OVEN_ID } from '../../../lib/ovens'
import {
  MODEL_PROFILE_INFERENCE_MODES,
  MODEL_PROFILE_PERMISSION_LEVELS
} from '../../../lib/model-profiles'
import {
  DEFAULT_THINKING_LEVEL,
  parseThinkingLevel,
  resolveDefaultThinkingLevel
} from '../../../lib/thinking-presets'

/**
 * Where a delegated run happens and how it runs, resolved once for every worker
 * shape the app has.
 *
 * A dispatch and a pawn are the same thing wearing two names: both create a real
 * thread, run a prompt in it, and report the outcome back to the thread that
 * asked. They used to resolve their own model, account, oven and permission
 * separately, which is how a pawn ended up carrying the spawner's account onto
 * another harness and a dispatch ended up accepting a model the catalog did not
 * confirm. This module is that resolution, in one place, so the two surfaces can
 * never disagree about what a named target means.
 *
 * Two rules are unchanged from the dispatch contract and now hold for pawns too:
 * the agent resolves and the app validates, and a target the catalog does not
 * confirm is refused rather than guessed.
 */

/** A harness a delegation may name, from the registry or the ACP agent list. */
export interface DelegationHarness {
  id: string
  name: string
}

/** Everything target resolution reads, supplied by the chat engine. */
export interface DelegationTargetDeps {
  /** The provider catalogs the model picker uses for a project. */
  listProviderCatalogs: (projectId: string) => Promise<ProviderCatalog[]>
  /**
   * Discover a project's provider catalogs again, bypassing the snapshot the
   * model picker holds.
   *
   * A launch that has not discovered its catalogs yet reports every model id as
   * unknown, and a target list built from the same snapshot reads the same way,
   * so a named model retries once through this instead of sending the agent in a
   * circle.
   */
  refreshProviderCatalogs: (projectId: string) => Promise<ProviderCatalog[]>
  /** Every saved harness account, with `isDefault` on the user's chosen one. */
  listAccounts: () => Promise<HarnessAccount[]>
  /** Every configured Oven, plus the app's default. */
  listOvens: () => Promise<OvenState>
  /** The installed-harness inventory for one Oven (empty for this computer). */
  harnessInventory: (ovenId: string) => Promise<OvenHarnessInventoryItem[]>
  /** The harness a name refers to, including the user's own ACP agents. */
  resolveHarness: (harnessId: string) => Promise<DelegationHarness | null>
}

/** The target fields a tool call may name. Omission means "inherit". */
export interface DelegationTargetRequest {
  /** The project the run belongs to, used to read its provider catalogs. */
  projectId: string
  /** The settings of the thread asking, i.e. what an omission inherits. */
  base?: ThreadSettings
  harnessId?: string
  providerId?: string
  modelId?: string
  accountId?: string
  ovenId?: string
  ovenPath?: string
  permissionLevel?: PermissionLevel
  thinkingLevel?: ThinkingLevel
  inferenceMode?: InferenceMode
  /**
   * The thinking level to use when this call names none and the caller has a
   * floor of its own (a pawn runs at the lowest level). Undefined keeps the
   * dispatch rule: the model's own default, then the inherited level.
   */
  thinkingFloor?: ThinkingLevel
  /**
   * The permission tier to use when this call names none and the caller has its
   * own policy (a pawn starts at the app default). Undefined inherits the
   * asking thread's tier.
   */
  permissionFallback?: PermissionLevel
}

/** A resolved target, complete enough to create a thread from. */
export interface DelegationTarget {
  /** The full settings the run is created with. */
  settings: ThreadSettings
  harness: DelegationHarness
  oven: Oven
  /** The catalog entry the named model came from, when one was named. */
  catalog: ProviderCatalog | null
  model: ProviderModel | null
  account: { id: string }
  accountLabel: string
  /** True when this call named no model and took the asking thread's own. */
  inheritedModel: boolean
}

/**
 * Read the target fields a tool call carries.
 *
 * Both delegation surfaces take a raw tool input, so the parsing lives here
 * beside the rules it feeds: an omitted field stays absent (an explicit
 * `undefined` would read as "named" and be refused), and a field the schema does
 * not define is ignored rather than trusted.
 */
export function delegationFieldsFromInput(
  input: Record<string, unknown>
): Omit<DelegationTargetRequest, 'projectId' | 'base' | 'thinkingFloor' | 'permissionFallback'> {
  const harnessId = stringValue(input['harnessId'])
  const providerId = stringValue(input['providerId'])
  const modelId = stringValue(input['modelId'])
  const accountId = stringValue(input['accountId'])
  const ovenId = stringValue(input['ovenId'])
  const ovenPath = stringValue(input['ovenPath'])
  const thinkingLevel = parseThinkingLevel(input['thinkingLevel'])
  const inferenceMode = resolveDelegationInferenceMode(input['inferenceMode'])
  const permissionLevel = resolveDelegationPermissionLevel(input['permissionLevel'])
  return {
    ...(harnessId ? { harnessId } : {}),
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(accountId ? { accountId } : {}),
    ...(ovenId ? { ovenId } : {}),
    ...(ovenPath ? { ovenPath } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(inferenceMode ? { inferenceMode } : {}),
    ...(permissionLevel ? { permissionLevel } : {})
  }
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** The provider catalog and model a delegation names, or null when unconfirmed. */
export function findDelegationModel(
  catalogs: readonly ProviderCatalog[],
  harnessId: string,
  providerId: string,
  modelId: string
): { catalog: ProviderCatalog; model: ProviderModel } | null {
  const catalog = catalogs.find(
    (candidate) => candidate.harnessId === harnessId && candidate.id === providerId
  )
  const model = catalog?.models.find((candidate) => candidate.id === modelId)
  return catalog && model ? { catalog, model } : null
}

/**
 * The account a delegation runs under.
 *
 * A named account must exist for the harness; an unnamed one falls back to the
 * account the app marks as default, and then to the harness default. The caller
 * is expected to have asked the user when the harness has no default and none
 * was named, so reaching the harness default here is a definite choice, never a
 * silent substitution between two real accounts.
 */
export function resolveDelegationAccount(
  accounts: readonly HarnessAccount[],
  harnessId: string,
  accountId: string | undefined
): HarnessAccount {
  const forHarness = accounts.filter((account) => account.harnessId === harnessId)
  if (accountId) {
    const named = forHarness.find((account) => account.id === accountId)
    if (!named) throw new Error(`Unknown account "${accountId}" for ${harnessId}.`)
    return named
  }
  const preferred = forHarness.find((account) => account.isDefault === true) ?? forHarness[0]
  if (preferred) return preferred
  // A harness with no managed account still runs under its synthetic default,
  // which is what the composer does when the picker has nothing to show.
  return {
    id: `${harnessId}.default`,
    harnessId,
    providerId: '',
    providerName: harnessId,
    label: 'Default',
    containerKind: 'legacy-default',
    createdAt: 0,
    updatedAt: 0
  }
}

/** The named inference tier, validating the value the tool accepted. */
export function resolveDelegationInferenceMode(value: unknown): InferenceMode | undefined {
  const named = stringValue(value)
  if (!named) return undefined
  if (!MODEL_PROFILE_INFERENCE_MODES.includes(named as InferenceMode)) {
    throw new Error(
      `Unknown inference mode "${named}". Use one of: ${MODEL_PROFILE_INFERENCE_MODES.join(', ')}.`
    )
  }
  return named as InferenceMode
}

/** The named permission tier, or undefined when the caller did not name one. */
export function resolveDelegationPermissionLevel(value: unknown): PermissionLevel | undefined {
  const named = stringValue(value)
  if (!named) return undefined
  if (!MODEL_PROFILE_PERMISSION_LEVELS.includes(named as PermissionLevel)) {
    throw new Error(
      `Unknown permission level "${named}". Use one of: ${MODEL_PROFILE_PERMISSION_LEVELS.join(', ')}.`
    )
  }
  return named as PermissionLevel
}

/** The named thinking level, validated against what the model actually offers. */
export function resolveDelegationThinkingLevel(
  named: ThinkingLevel | undefined,
  offered: readonly string[] | undefined
): ThinkingLevel | undefined {
  if (named) {
    if (offered && offered.length > 0 && !offered.includes(named)) {
      throw new Error(
        `This model does not offer the "${named}" thinking level. It offers: ${offered.join(', ')}.`
      )
    }
    return named
  }
  return resolveDefaultThinkingLevel(
    offered?.map((id) => ({ id, label: id })),
    undefined,
    undefined
  )
}

/**
 * Resolve a named target against the real catalog, or inherit the asking
 * thread's own.
 *
 * Nothing here guesses: a model named without its harness and provider is
 * refused, a model the catalog cannot confirm after one forced discovery is
 * refused, and an Oven that reports its harness missing is refused before a
 * thread is created on it.
 */
export async function resolveDelegationTarget(
  deps: DelegationTargetDeps,
  request: DelegationTargetRequest
): Promise<DelegationTarget> {
  const base = request.base
  const namedHarness = request.harnessId
  const namedProvider = request.providerId
  const namedModel = request.modelId
  const namesModel = Boolean(namedHarness || namedProvider || namedModel)

  let harnessId: string
  let providerId: string
  let modelId: string
  if (namesModel) {
    if (!namedHarness || !namedProvider || !namedModel) {
      throw new Error(
        'A delegation that names a model must name harnessId, providerId and modelId together. Omit all three to inherit the model this thread is using.'
      )
    }
    harnessId = namedHarness
    providerId = namedProvider
    modelId = namedModel
  } else if (base) {
    harnessId = base.harnessId
    providerId = base.providerId
    modelId = base.modelId
  } else {
    throw new Error(
      'This conversation has no model to inherit, so the delegation must name harnessId, providerId and modelId.'
    )
  }

  const harness = await deps.resolveHarness(harnessId)
  if (!harness) throw new Error(`Unknown harness "${harnessId}". Read cio_orchestrate_targets.`)

  const ovenId = request.ovenId ?? base?.ovenId ?? LOCAL_OVEN_ID
  const ovenPath = request.ovenPath ?? (ovenId === base?.ovenId ? base?.ovenPath : undefined)

  const [catalogs, accounts, state] = await Promise.all([
    deps.listProviderCatalogs(request.projectId),
    deps.listAccounts(),
    deps.listOvens()
  ])

  let resolved = namesModel ? findDelegationModel(catalogs, harnessId, providerId, modelId) : null
  if (namesModel && !resolved) {
    // The snapshot the picker holds is the only source this check reads, and it
    // is empty until the app has discovered once. Discover here rather than
    // telling the agent to re-read a target list built from the same snapshot.
    resolved = findDelegationModel(
      await deps.refreshProviderCatalogs(request.projectId),
      harnessId,
      providerId,
      modelId
    )
    if (!resolved) {
      throw new Error(
        `The ${harnessId} catalog has no provider "${providerId}" with model "${modelId}", even after discovering the catalogs again. Read cio_orchestrate_targets and copy an id from it exactly.`
      )
    }
  }
  const { catalog, model } = resolved ?? { catalog: null, model: null }

  const oven = state.ovens.find((candidate) => candidate.id === ovenId)
  if (!oven) throw new Error(`Unknown Oven "${ovenId}". Read cio_orchestrate_targets.`)

  if (isRemoteOvenId(ovenId)) {
    const inventory = await deps.harnessInventory(ovenId)
    const item = inventory.find((entry) => entry.harnessId === harnessId)
    if (
      item &&
      (item.health === 'missing' || item.health === 'broken' || item.health === 'unsupported')
    ) {
      throw new Error(
        `The Oven "${oven.name}" cannot run ${harness.name}: its inventory reports ${item.health}. Pick a machine that has it, or ask the user.`
      )
    }
  }

  const inheritedModel = !namesModel && base?.harnessId === harnessId
  // Only a run that inherits both the harness and the model may inherit the
  // account id: that is the one case where the stored id provably belongs to the
  // harness the run will use. A named or cross-harness run resolves it against
  // the account registry, so another harness's id can never ride along.
  const account =
    inheritedModel && !request.accountId
      ? {
          id: base?.accountId ?? resolveDelegationAccount(accounts, harnessId, undefined).id
        }
      : resolveDelegationAccount(accounts, harnessId, request.accountId)
  const accountLabel =
    accounts.find((candidate) => candidate.id === account.id)?.label ?? account.id

  const thinkingLevel =
    resolveDelegationThinkingLevel(
      request.thinkingLevel,
      model?.thinkingPresets?.map((preset) => preset.id)
    ) ??
    request.thinkingFloor ??
    (inheritedModel ? base?.thinkingLevel : undefined) ??
    DEFAULT_THINKING_LEVEL
  const inferenceMode = request.inferenceMode ?? (inheritedModel ? base?.inferenceMode : undefined)
  // A delegation always runs under a real permission tier: the one the agent
  // named, the caller's own fallback, the one the asking thread already runs
  // with, or the app default.
  const permissionLevel: PermissionLevel =
    request.permissionLevel ?? request.permissionFallback ?? base?.permissionLevel ?? 'auto_review'

  const settings: ThreadSettings = {
    harnessId,
    providerId,
    modelId,
    accountId: account.id,
    thinkingLevel,
    ...(inferenceMode ? { inferenceMode } : {}),
    ...(inheritedModel && base?.contextWindow !== undefined
      ? { contextWindow: base.contextWindow }
      : {}),
    permissionLevel,
    ovenId,
    ...(ovenPath ? { ovenPath } : {})
  }

  return {
    settings,
    harness,
    oven,
    catalog,
    model,
    account,
    accountLabel,
    inheritedModel
  }
}
