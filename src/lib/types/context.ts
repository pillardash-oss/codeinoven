export interface ContextConfig {
  systemPrompt: string
  projectNotes: string
  includedSkills: string[]
  includedMCPs: string[]
  excludedHistoryEntries: string[]
  checkpointId?: string
  annotations: string[]
}

export interface ContextOutput {
  messages: Array<{ role: string; content: string }>
  metadata: { tokenCount: number; sources: string[] }
}
