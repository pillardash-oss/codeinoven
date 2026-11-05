import type { ProviderCatalog, ProviderModel } from '../../../lib/types'
import { acpArray, acpRecord, acpString, type AcpNewSessionResult } from './acp-protocol'

/** A mode the agent exposes, kept so the driver can name it in diagnostics. */
export interface AcpModeSummary {
  id: string
  name: string
}

/**
 * Build the model catalog from a `session/new` result.
 *
 * ACP has no global catalog: models are per session, so what the agent reports
 * for a session in this project is the honest list for this project. An agent
 * that reports no models still yields a provider with one implicit model so the
 * composer can send a turn (the agent picks its own default).
 */
export function acpProviderCatalog(
  result: AcpNewSessionResult,
  agentName: string,
  providerId: string
): ProviderCatalog[] {
  const reported = acpArray(acpRecord(result.models)?.['availableModels'])
  const models: ProviderModel[] = []
  for (const entry of reported) {
    const record = acpRecord(entry)
    const modelId = acpString(record?.['modelId'])
    if (!modelId) continue
    models.push({
      id: modelId,
      providerId,
      name: acpString(record?.['name']) ?? modelId,
      reasoning: false,
      attachment: false,
      toolcall: true
    })
  }
  if (models.length === 0) {
    models.push({
      id: 'default',
      providerId,
      name: 'Agent default',
      reasoning: false,
      attachment: false,
      toolcall: true
    })
  }
  return [
    {
      id: providerId,
      name: agentName,
      harnessId: 'acp',
      models,
      supportsAttachments: false
    }
  ]
}

/** Mode list from a `session/new` result, for the settings surface. */
export function acpModes(result: AcpNewSessionResult): AcpModeSummary[] {
  const modes: AcpModeSummary[] = []
  for (const entry of acpArray(acpRecord(result.modes)?.['availableModes'])) {
    const record = acpRecord(entry)
    const id = acpString(record?.['id'])
    if (!id) continue
    modes.push({ id, name: acpString(record?.['name']) ?? id })
  }
  return modes
}

/** The model a session already selected, so a turn only sets it when it differs. */
export function acpCurrentModel(result: AcpNewSessionResult): string | undefined {
  return acpString(acpRecord(result.models)?.['currentModelId'])
}
