import { baseUrlProviderStore } from '$lib/stores/base-url-providers.svelte'
import { isCodeInOvenCustomProviderId } from '$shared/custom-provider-id'
import { resolveDefaultThinkingLevel } from '$shared/thinking-presets'
import { fastSelectionModelId, supportsFastInference } from '$shared/fast-inference'
import type {
  InferenceMode,
  PermissionLevel,
  ProviderCatalog,
  ThinkingLevel,
  ThreadSettings
} from '$shared/types'

/** Toolbar settings mutations, kept pure so the composer only commits the result. */
export function withPermissionLevel(
  resolved: ThreadSettings,
  level: PermissionLevel
): ThreadSettings {
  return { ...resolved, permissionLevel: level }
}

export function withFileSystemMode(resolved: ThreadSettings): ThreadSettings {
  return { ...resolved, fileSystemMode: resolved.fileSystemMode !== true }
}

export function withThinkingLevel(resolved: ThreadSettings, level: ThinkingLevel): ThreadSettings {
  return { ...resolved, thinkingLevel: level }
}

export function withInferenceMode(resolved: ThreadSettings, mode: InferenceMode): ThreadSettings {
  return {
    ...resolved,
    modelId:
      mode === 'fast'
        ? fastSelectionModelId(resolved.harnessId, resolved.modelId)
        : resolved.modelId,
    inferenceMode: mode
  }
}

export interface ModelSelectionInput {
  providerId: string
  modelId: string
  harnessId?: string
  accountId?: string
}

export function withModelSelection(
  resolved: ThreadSettings,
  resolvedProviders: ProviderCatalog[],
  selection: ModelSelectionInput
): ThreadSettings {
  const nextHarness = selection.harnessId ?? resolved.harnessId
  const provider = resolvedProviders.find(
    (candidate) => candidate.harnessId === nextHarness && candidate.id === selection.providerId
  )
  const model = provider?.models.find((candidate) => candidate.id === selection.modelId)
  const defaultThinkingLevel = baseUrlProviderStore.defaultThinkingLevel(
    nextHarness,
    selection.providerId,
    selection.modelId
  )
  const thinkingLevel = resolveDefaultThinkingLevel(
    model?.thinkingPresets,
    defaultThinkingLevel,
    resolved.thinkingLevel
  )
  const fastSupported = supportsFastInference(
    nextHarness,
    selection.providerId,
    model?.fastSupported
  )
  return {
    ...resolved,
    harnessId: selection.harnessId ?? resolved.harnessId,
    providerId: selection.providerId,
    modelId: selection.modelId,
    // Custom base URL providers run without an account: fall back to the
    // harness default only for real providers so a turn never gets a random
    // harness account stamped onto its attribution.
    accountId: isCodeInOvenCustomProviderId(selection.providerId)
      ? undefined
      : (selection.accountId ??
        (nextHarness !== resolved.harnessId
          ? `${nextHarness}.default`
          : (resolved.accountId ?? `${nextHarness}.default`))),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(fastSupported ? {} : { inferenceMode: 'normal' })
  }
}
