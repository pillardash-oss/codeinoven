/** Destination identity for restart-safe composer attachment files. */
export interface AttachmentStorageScope {
  kind: 'project' | 'chat'
  projectId: string
  threadId: string
}

export type ProviderType = 'cli' | 'api' | 'hybrid'

export type HarnessExecutionTarget =
  | { kind: 'native' }
  | { kind: 'wsl'; distribution: string }
  /** Runs from CodeInOven's bundled copy (no CLI install on this machine). */
  | { kind: 'bundled' }

/** Provider-normalized reasoning effort forwarded to the selected harness. */
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

/**
 * Inference speed contract for a turn. `fast` requests the harness's
 * speed-prioritizing tier under the hood   for opencode that is a `*-fast`
 * model id, for codex a `service_tier = "fast"` config override. Only models
 * the harness catalog marks fast-capable expose the choice. Defaults to `normal`.
 */
export type InferenceMode = 'normal' | 'fast'

/** How tool-call permissions are handled for a thread. */
export type PermissionLevel = 'auto_review' | 'full_access'

/** Harness/provider/model identity used for a secondary agent role. */
export interface AgentModelSelection {
  harnessId: string
  providerId: string
  modelId: string
  /** Credential container used for this role. Missing means the harness Default account. */
  accountId?: string
  /** Reasoning effort for the role. When absent, the thread's own level is used. */
  thinkingLevel?: ThinkingLevel
}

export type AgentRole = 'seniorEngineer' | 'worker' | 'auditor'

/** Reply to a tool permission request. */
export type PermissionReply = 'once' | 'always' | 'reject'

/** A model identity without thinking preferences, e.g. the model executing a turn. */
export type ModelIdentity = Pick<AgentModelSelection, 'harnessId' | 'providerId' | 'modelId'>
