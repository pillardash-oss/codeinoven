import { join } from 'path'
import { ROUTINE_AUTHORING_CHECKPOINT_LIMIT } from '../../lib/routine-authoring'
import { StorageEngine } from '../storage/storage-engine'

/** Directory under the config root that holds every per-routine artifact. */
const ROUTINE_DIRECTORY = 'routines'

/**
 * The checkpoint file name. One routine keeps exactly one checkpoint: the
 * Getting started interview is a conversation, so later state replaces earlier
 * state rather than accumulating a version per turn.
 */
const CHECKPOINT_FILE = 'getting-started.md'

/**
 * RoutineAuthoringCheckpoints   the app-owned record of what a routine's
 * Getting started interview has agreed so far.
 *
 * A routine's how-to is authored in an interview, and that interview has to
 * survive the model or harness the user is working on changing mid-way. The
 * harness transcript cannot carry that: a switch rotates the session and
 * replays a budgeted recap, and a compaction drops the oldest exchanges. So the
 * agent keeps this checkpoint current, and the chat engine re-injects it,
 * together with every answer the user already submitted, into every authoring
 * turn. A fresh session therefore resumes the interview instead of re-asking
 * it.
 *
 * Writes are serialized per routine and atomic, and the file is bounded, so a
 * runaway save can never grow the context every later turn pays for. The
 * checkpoint is deleted with its routine's storage.
 */
export class RoutineAuthoringCheckpoints {
  private readonly operations = new Map<string, Promise<unknown>>()

  constructor(private readonly storage: StorageEngine) {}

  /** Path of one routine's checkpoint, relative to the config root. */
  path(routineId: string): string {
    if (!routineId || routineId.includes('/') || routineId.includes('\\')) {
      throw new Error('Invalid routine id')
    }
    return join(ROUTINE_DIRECTORY, routineId, CHECKPOINT_FILE)
  }

  /** The checkpoint, or null when the interview has not saved one yet. */
  async read(routineId: string): Promise<string | null> {
    const content = await this.storage.readRaw(this.path(routineId))
    const trimmed = content?.trim()
    return trimmed ? trimmed : null
  }

  save(routineId: string, markdown: string): Promise<{ path: string }> {
    return this.serialize(routineId, async () => {
      const checkpoint = markdown.trim()
      if (!checkpoint || checkpoint.length > ROUTINE_AUTHORING_CHECKPOINT_LIMIT) {
        throw new Error(
          `The Getting started checkpoint must contain 1-${ROUTINE_AUTHORING_CHECKPOINT_LIMIT} characters`
        )
      }
      await this.storage.writeRaw(this.path(routineId), `${checkpoint}\n`)
      return { path: this.path(routineId) }
    })
  }

  /** Drop a routine's checkpoint   the interview is being started over. */
  clear(routineId: string): Promise<void> {
    return this.serialize(routineId, () => this.storage.removeRaw(this.path(routineId)))
  }

  private async serialize<T>(routineId: string, operation: () => Promise<T>): Promise<T> {
    const running = (this.operations.get(routineId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation)
    this.operations.set(routineId, running)
    try {
      return await running
    } finally {
      if (this.operations.get(routineId) === running) this.operations.delete(routineId)
    }
  }
}
