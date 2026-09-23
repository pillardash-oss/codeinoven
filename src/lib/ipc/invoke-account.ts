import type { Contract } from './contract-helpers'

export const invokeAccountContract = {
  'account:getLocalUsage': {} as Contract<
    [range: import('../types').LocalProfileAnalyticsRange],
    import('../types').LocalProfileAnalytics
  >,
  'account:clearLocalUsage': {} as Contract<
    [input: import('../types').LocalUsageClearInput],
    import('../types').LocalUsageRecordCounts
  >,
  'account:getRankingQueue': {} as Contract<[], import('../types').LocalRankingQueueStatus>,
  'account:gradeRankingQueue': {} as Contract<
    [scope: import('../types').LocalRankingGradeScope],
    import('../types').LocalRankingGradeProgress
  >,
  'account:cancelRankingGrade': {} as Contract<[], void>,
  'memory:getLayers': {} as Contract<
    [projectId: string, threadId: string],
    import('../types').BehaviorLayer[]
  >,
  'memory:getRaw': {} as Contract<[projectId?: string, threadId?: string], string>,
  'memory:saveRaw': {} as Contract<[markdown: string, projectId?: string, threadId?: string], void>,
  'memory:getEntries': {} as Contract<
    [projectId?: string, threadId?: string],
    import('../types').MemoryEntry[]
  >,
  'memory:saveEntries': {} as Contract<
    [entries: import('../types').MemoryEntry[], projectId?: string, threadId?: string],
    void
  >,
  'memory:getMergedEntries': {} as Contract<[projectId: string], import('../types').MemoryEntry[]>,
  'memory:addEntry': {} as Contract<
    [
      label: string,
      content: string,
      options?: {
        category?: import('../types').MemoryCategory
        priority?: import('../types').MemoryPriority
        scope?: import('../types').MemoryScope
        source?: import('../types').MemorySource
        modelKeys?: string[]
        projectId?: string
        threadId?: string
      }
    ],
    import('../types').MemoryEntry
  >,
  'memory:removeEntry': {} as Contract<
    [entryId: string, projectId?: string, threadId?: string],
    boolean
  >,
  'memory:searchEntries': {} as Contract<
    [
      query: string,
      options?: {
        category?: import('../types').MemoryCategory
        priority?: import('../types').MemoryPriority
        projectId?: string
      }
    ],
    import('../types').MemoryEntry[]
  >,
  'memory:getPendingProposals': {} as Contract<
    [projectId?: string],
    import('../types').MemoryProposal[]
  >,
  'memory:approveProposal': {} as Contract<
    [proposalId: string, projectId?: string],
    import('../types').MemoryEntry | null
  >,
  'memory:rejectProposal': {} as Contract<[proposalId: string, projectId?: string], boolean>,
  'memory:createProposal': {} as Contract<
    [
      label: string,
      content: string,
      options?: {
        category?: import('../types').MemoryCategory
        priority?: import('../types').MemoryPriority
        scope?: import('../types').MemoryScope
        modelKeys?: string[]
        projectId?: string
        threadId?: string
      }
    ],
    import('../types').MemoryProposal
  >,
  'memory:export': {} as Contract<
    [kind: import('../types').MemoryExportKind, projectId?: string],
    string | null
  >,
  'memory:import': {} as Contract<[], import('../types').MemoryImportPreview | null>,
  'memory:importApply': {} as Contract<
    [
      preview: import('../types').MemoryImportPreview,
      kind: import('../types').MemoryExportKind,
      projectId?: string
    ],
    { added: number; skipped: number }
  >
}
