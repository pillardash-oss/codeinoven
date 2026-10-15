import { join } from 'path'
import { ASSISTANT_AUTHORING_CHECKPOINT_LIMIT } from '../../lib/assistant-authoring'
import { StorageEngine } from '../storage/storage-engine'

/** Directory under the config root that holds every per-assistant artifact. */
const ASSISTANT_DIRECTORY = 'assistants'

/**
 * The checkpoint file name. One assistant keeps exactly one checkpoint: the
 * Getting started interview is a conversation, so later state replaces earlier
 * state rather than accumulating a version per turn.
 */
const CHECKPOINT_FILE = 'getting-started.md'

/**
 * AssistantAuthoringCheckpoints   the app-owned record of what an assistant's
 * Getting started interview has agreed so far.
 *
 * An assistant's knowledge is authored in an interview, and that interview has to
 * survive the model or harness the user is working on changing mid-way. The
 * harness transcript cannot carry that: a switch rotates the session and
 * replays a budgeted recap, and a compaction drops the oldest exchanges. So the
 * agent keeps this checkpoint current, and the chat engine re-injects it,
 * together with every answer the user already submitted, into every authoring
 * turn. A fresh session therefore resumes the interview instead of re-asking
 * it.
 *
 * Writes are serialized per assistant and atomic, and the file is bounded, so a
 * runaway save can never grow the context every later turn pays for. The
 * checkpoint is deleted with its assistant's storage.
 */
export class AssistantAuthoringCheckpoints {
  private readonly operations = new Map<string, Promise<unknown>>()

  constructor(private readonly storage: StorageEngine) {}

  /** Path of one assistant's checkpoint, relative to the config root. */
  path(assistantId: string): string {
    if (!assistantId || assistantId.includes('/') || assistantId.includes('\\')) {
      throw new Error('Invalid assistant id')
    }
    return join(ASSISTANT_DIRECTORY, assistantId, CHECKPOINT_FILE)
  }

  /** The checkpoint, or null when the interview has not saved one yet. */
  async read(assistantId: string): Promise<string | null> {
    const content = await this.storage.readRaw(this.path(assistantId))
    const trimmed = content?.trim()
    return trimmed ? trimmed : null
  }

  save(assistantId: string, markdown: string): Promise<{ path: string }> {
    return this.serialize(assistantId, async () => {
      const checkpoint = markdown.trim()
      if (!checkpoint || checkpoint.length > ASSISTANT_AUTHORING_CHECKPOINT_LIMIT) {
        throw new Error(
          `The Getting started checkpoint must contain 1-${ASSISTANT_AUTHORING_CHECKPOINT_LIMIT} characters`
        )
      }
      await this.storage.writeRaw(this.path(assistantId), `${checkpoint}\n`)
      return { path: this.path(assistantId) }
    })
  }

  /** Drop an assistant's checkpoint   the interview is being started over. */
  clear(assistantId: string): Promise<void> {
    return this.serialize(assistantId, () => this.storage.removeRaw(this.path(assistantId)))
  }

  private async serialize<T>(assistantId: string, operation: () => Promise<T>): Promise<T> {
    const running = (this.operations.get(assistantId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation)
    this.operations.set(assistantId, running)
    try {
      return await running
    } finally {
      if (this.operations.get(assistantId) === running) this.operations.delete(assistantId)
    }
  }
}
