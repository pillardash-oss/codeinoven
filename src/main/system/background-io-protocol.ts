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
  /**
   * Erase whole directory trees off the main thread.
   *
   * A project folder, its browser profile, and its app-owned scratch data can be
   * gigabytes across hundreds of thousands of entries, and every directory entry
   * is a syscall plus a promise callback on the thread that issued the walk.
   * Removing them here keeps that work on the worker so a project deletion never
   * stalls painting, IPC, or an agent stream.
   */
  | { kind: 'remove-trees'; paths: string[]; force: boolean }
  /**
   * Rebuild the newest turn of a durable working-trace log.
   *
   * The log is append-only and thread-wide, so its newest turn sits behind the
   * thread's entire history. Reading it is the most expensive thing a thread
   * open does, and it used to run on the main process; the walk lives in the
   * background worker so opening, hovering, and streaming never wait behind it.
   */
  | { kind: 'turn-stream-tail'; path: string; size: number; windowStartTs: number }
  /** Read one closed span of a durable working-trace log, newest turn excluded. */
  | {
      kind: 'turn-stream-range'
      path: string
      fromByte: number
      size: number
      windowStartTs?: number
      windowEndTs?: number
    }
