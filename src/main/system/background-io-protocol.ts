import type { ThreadEmbeddingRecord } from '../../lib/search/types'
import type { PromptAttachment } from '../../lib/types'
export type BackgroundIoRequest =
  | { kind: 'index-read'; path: string; snapshot?: string }
  | { kind: 'index-encode'; records: ThreadEmbeddingRecord[] }
  | { kind: 'index-rank'; records: ThreadEmbeddingRecord[]; query: Float32Array; limit: number }
  | { kind: 'dangling-references'; root: string; deletedPaths: string[]; files: string[] }
  | { kind: 'project-icon'; projectPath: string }
  | { kind: 'prepare-icon'; sourcePath: string }
  | { kind: 'document'; attachment: PromptAttachment; preview: boolean }
  | { kind: 'list-directory'; root: string; directory: string; relativeDirectory: string }
  | { kind: 'credential-read'; databasePath: string; values: boolean }
  | { kind: 'credential-delete'; databasePath: string; candidates: string[] }
