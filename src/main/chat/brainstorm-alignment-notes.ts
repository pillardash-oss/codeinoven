import { createHash } from 'crypto'
import { join } from 'path'
import type { Project } from '../../lib/types'
import { featureArtifactDirectory } from '../../lib/project-artifacts'
import { BRAINSTORM_ALIGNMENT_NOTE_LIMIT } from '../../lib/brainstorm/brainstorm-alignment'
import type { StorageEngine } from '../storage/storage-engine'

export interface BrainstormAlignmentRound {
  projectId: string
  threadId: string
  project: Project
  featureSlug: string
  version: number
}

interface GenerationApproval {
  version: number
  requestId: string
  notesHash: string
}

/** Small atomic notes and a one-use, version-bound human approval; no model calls. */
export class BrainstormAlignmentNotes {
  private readonly operations = new Map<string, Promise<unknown>>()

  constructor(private readonly storage: StorageEngine) {}

  path(round: BrainstormAlignmentRound): string {
    return join(featureArtifactDirectory(round.featureSlug), this.filename(round.version)).replace(
      /\\/gu,
      '/'
    )
  }

  async read(round: BrainstormAlignmentRound): Promise<string | null> {
    return this.storage.readProjectSpecRaw(
      round.projectId,
      round.featureSlug,
      this.filename(round.version),
      round.project
    )
  }

  save(
    round: BrainstormAlignmentRound,
    markdown: string
  ): Promise<{ path: string; version: number }> {
    return this.serialize(round, async () => {
      const notes = markdown.trim()
      if (!notes || notes.length > BRAINSTORM_ALIGNMENT_NOTE_LIMIT) {
        throw new Error(
          `Alignment notes must contain 1–${BRAINSTORM_ALIGNMENT_NOTE_LIMIT} characters`
        )
      }
      const previous = await this.read(round)
      if (previous?.trim() !== notes) {
        await this.storage.remove(this.approvalPath(round))
        await this.storage.writeProjectSpecRaw(
          round.projectId,
          round.featureSlug,
          this.filename(round.version),
          `${notes}\n`,
          round.project
        )
      }
      return { path: this.path(round), version: round.version }
    })
  }

  approve(round: BrainstormAlignmentRound, requestId: string): Promise<void> {
    return this.serialize(round, async () => {
      const notes = await this.read(round)
      if (!notes?.trim())
        throw new Error('Save the alignment notes before requesting document generation')
      await this.storage.write(this.approvalPath(round), {
        version: round.version,
        requestId,
        notesHash: this.hash(notes)
      } satisfies GenerationApproval)
    })
  }

  clearApproval(round: BrainstormAlignmentRound): Promise<void> {
    return this.serialize(round, () => this.storage.remove(this.approvalPath(round)))
  }

  consumeApproval(round: BrainstormAlignmentRound): Promise<boolean> {
    return this.serialize(round, async () => {
      const approval = await this.storage.read<GenerationApproval>(this.approvalPath(round))
      if (!approval) return false
      await this.storage.remove(this.approvalPath(round))
      const notes = await this.read(round)
      return (
        approval.version === round.version &&
        notes !== null &&
        approval.notesHash === this.hash(notes)
      )
    })
  }

  private filename(version: number): string {
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid alignment version')
    return `align-note-${version}.md`
  }

  private approvalPath(round: BrainstormAlignmentRound): string {
    return `projects/${round.projectId}/threads/${round.threadId}/brainstorm-generation-approval.json`
  }

  private hash(notes: string): string {
    return createHash('sha256').update(notes.trim()).digest('hex')
  }

  private async serialize<T>(
    round: BrainstormAlignmentRound,
    operation: () => Promise<T>
  ): Promise<T> {
    const key = `${round.projectId}:${round.threadId}`
    const running = (this.operations.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation)
    this.operations.set(key, running)
    try {
      return await running
    } finally {
      if (this.operations.get(key) === running) this.operations.delete(key)
    }
  }
}
