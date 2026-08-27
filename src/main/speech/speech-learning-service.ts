import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  SpeechExtractedLesson,
  SpeechLearningObservation,
  SpeechLesson,
  SpeechLessonKind,
  SpeechScope
} from '../../lib/speech/types'
import { MAX_CONTEXT_LESSONS, MAX_GLOBAL_LESSONS } from '../../lib/speech/types'
import { atomicWrite } from '../../lib/utils'

interface LessonIndex {
  version: 1
  lessons: SpeechLesson[]
}

const LESSON_KINDS: ReadonlySet<string> = new Set([
  'vocabulary',
  'punctuation',
  'phrasing',
  'formatting',
  'style'
])

/**
 * Instruct models compare the raw dictation transcript with the text the user
 * actually sent and return durable style lessons. This store keeps those
 * structured lessons bounded and visible; it never reads or mutates model
 * files and never derives rules with pattern matching.
 */
export class SpeechLearningService {
  private index: LessonIndex = { version: 1, lessons: [] }
  private writeTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly learner?: LessonLearner
  ) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (this.isIndex(value)) this.index = value
    } catch (cause) {
      const code = cause instanceof Error && 'code' in cause ? String(cause.code) : ''
      if (code !== 'ENOENT') throw cause
    }
  }

  list(scope?: SpeechScope): SpeechLesson[] {
    return this.index.lessons
      .filter((lesson) => !scope || inScope(lesson.scope, scope))
      .map((lesson) => structuredClone(lesson))
  }

  /** Enabled lessons applicable to a cleanup run: global plus the active scope. */
  enabled(scope: SpeechScope): SpeechLesson[] {
    return this.index.lessons
      .filter((lesson) => lesson.enabled && appliesTo(lesson.scope, scope))
      .sort((left, right) => right.confidence - left.confidence)
      .map((lesson) => structuredClone(lesson))
  }

  /**
   * Compare the raw transcript with what the user actually sent. Whitespace-only
   * differences never reach the model; real edits are distilled by an instruct
   * LLM into structured lessons which are merged into this store.
   */
  async observe(observation: SpeechLearningObservation): Promise<SpeechLesson[]> {
    if (!hasMeaningfulChange(observation.insertedText, observation.sentText)) return []
    if (!this.learner) return []
    const extracted = await this.learner(observation)
    if (!extracted.length) return []
    const learned: SpeechLesson[] = []
    for (const lesson of extracted) {
      const merged = this.merge(lesson, observation.scope, observation.sentAt)
      if (merged) learned.push(structuredClone(merged))
    }
    if (learned.length) await this.persist()
    return learned
  }

  async setEnabled(lessonId: string, enabled: boolean): Promise<SpeechLesson> {
    const lesson = this.requireLesson(lessonId)
    lesson.enabled = enabled
    lesson.updatedAt = Date.now()
    await this.persist()
    return structuredClone(lesson)
  }

  async delete(lessonId: string): Promise<void> {
    this.requireLesson(lessonId)
    this.index.lessons = this.index.lessons.filter((lesson) => lesson.id !== lessonId)
    await this.persist()
  }

  private merge(
    extracted: SpeechExtractedLesson,
    scope: SpeechScope,
    now: number
  ): SpeechLesson | null {
    const key = instructionKey(extracted.instruction)
    if (!key || !LESSON_KINDS.has(extracted.kind)) return null
    if (scope.kind !== 'project' && scope.kind !== 'inbox') return null
    const existing = this.index.lessons.find((lesson) => {
      if (lesson.kind !== extracted.kind) return false
      if (instructionKey(lesson.instruction) !== key) return false
      if (lesson.scope.kind !== scope.kind) return false
      if (scope.kind === 'project') {
        return lesson.scope.kind === 'project' && lesson.scope.projectId === scope.projectId
      }
      return true
    })
    if (existing) {
      existing.evidenceCount += 1
      existing.confidence = Math.min(0.99, existing.confidence + 0.08)
      existing.lastReinforcedAt = now
      existing.updatedAt = now
      existing.examples = mergeExamples(existing.examples, extracted.examples)
      this.enforceLimits(existing.scope)
      return existing
    }
    const lesson: SpeechLesson = {
      id: randomUUID(),
      kind: extracted.kind as SpeechLessonKind,
      scope: structuredClone(scope),
      instruction: extracted.instruction.trim(),
      examples: extracted.examples.slice(0, 4),
      confidence: 0.75,
      evidenceCount: 1,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      lastReinforcedAt: now
    }
    this.index.lessons.push(lesson)
    this.enforceLimits(scope)
    return lesson
  }

  private enforceLimits(scope: SpeechScope): void {
    const limit = scope.kind === 'global' ? MAX_GLOBAL_LESSONS : MAX_CONTEXT_LESSONS
    const scoped = this.index.lessons.filter((lesson) => sameBucket(lesson.scope, scope))
    scoped.sort((left, right) => {
      if (left.enabled !== right.enabled) return left.enabled ? 1 : -1
      if (left.confidence !== right.confidence) return left.confidence - right.confidence
      return left.lastReinforcedAt - right.lastReinforcedAt
    })
    const remove = new Set(
      scoped.slice(0, Math.max(0, scoped.length - limit)).map((lesson) => lesson.id)
    )
    if (remove.size > 0) {
      this.index.lessons = this.index.lessons.filter((lesson) => !remove.has(lesson.id))
    }
  }

  private requireLesson(lessonId: string): SpeechLesson {
    const lesson = this.index.lessons.find((item) => item.id === lessonId)
    if (!lesson) throw new Error('Learned lesson was not found.')
    return lesson
  }

  private async persist(): Promise<void> {
    const payload = `${JSON.stringify(this.index, null, 2)}\n`
    this.writeTail = this.writeTail.then(() => atomicWrite(this.filePath, payload))
    await this.writeTail
  }

  private isIndex(value: unknown): value is LessonIndex {
    if (typeof value !== 'object' || value === null) return false
    const candidate = value as Record<string, unknown>
    return candidate['version'] === 1 && Array.isArray(candidate['lessons'])
  }
}

export type LessonLearner = (
  observation: SpeechLearningObservation
) => Promise<SpeechExtractedLesson[]>

function hasMeaningfulChange(inserted: string, sent: string): boolean {
  const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim()
  return normalize(inserted) !== normalize(sent)
}

function instructionKey(instruction: string): string {
  return instruction.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function mergeExamples(current: SpeechLesson['examples'], incoming: SpeechLesson['examples']): SpeechLesson['examples'] {
  const merged = [...current]
  for (const example of incoming) {
    if (merged.some((item) => item.from === example.from && item.to === example.to)) continue
    merged.push(example)
  }
  return merged.slice(-4)
}

function scopeKeyOf(scope: SpeechScope): string {
  return scope.kind === 'project' ? `project:${scope.projectId}` : scope.kind
}

function sameBucket(left: SpeechScope, right: SpeechScope): boolean {
  return scopeKeyOf(left) === scopeKeyOf(right)
}

function appliesTo(lessonScope: SpeechScope, active: SpeechScope): boolean {
  if (lessonScope.kind === 'global') return true
  return sameBucket(lessonScope, active)
}

function inScope(lessonScope: SpeechScope, filter: SpeechScope): boolean {
  if (filter.kind === 'global') return true
  return sameBucket(lessonScope, filter)
}
