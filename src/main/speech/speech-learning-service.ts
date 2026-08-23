import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  SpeechCorrectionObservation,
  SpeechCorrectionRule,
  SpeechScope
} from '../../lib/speech/types'
import { MAX_CONTEXT_CORRECTION_RULES, MAX_GLOBAL_CORRECTION_RULES } from '../../lib/speech/types'
import { atomicWrite } from '../../lib/utils'

interface RuleIndex {
  version: 1
  rules: SpeechCorrectionRule[]
}

function scopeKey(scope: SpeechScope): string {
  return scope.kind === 'project' ? `project:${scope.projectId}` : scope.kind
}

function sameScope(left: SpeechScope, right: SpeechScope): boolean {
  return scopeKey(left) === scopeKey(right)
}

/** Conservative, bounded correction learning. It never reads or mutates model files. */
export class SpeechLearningService {
  private index: RuleIndex = { version: 1, rules: [] }
  private writeTail: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

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

  list(scope?: SpeechScope): SpeechCorrectionRule[] {
    return this.index.rules
      .filter((rule) => !scope || sameScope(rule.scope, scope))
      .map((rule) => structuredClone(rule))
  }

  enabled(scope: SpeechScope): SpeechCorrectionRule[] {
    return this.index.rules
      .filter(
        (rule) => rule.enabled && (rule.scope.kind === 'global' || sameScope(rule.scope, scope))
      )
      .sort((left, right) => right.confidence - left.confidence)
      .map((rule) => structuredClone(rule))
  }

  async observe(observation: SpeechCorrectionObservation): Promise<SpeechCorrectionRule | null> {
    const { span, sentText } = observation
    if (sentText.length > 100_000 || span.insertedText.length < 2) return null
    const prefix = span.insertedText.slice(0, Math.min(16, span.insertedText.length))
    const expectedStart = Math.min(span.startOffset, sentText.length)
    const nearby = sentText.indexOf(prefix, Math.max(0, expectedStart - 32))
    if (nearby < 0 || nearby > expectedStart + 32) return null

    const sourceWords = span.insertedText.trim().split(/\s+/u)
    const sentWindow = sentText.slice(nearby, nearby + span.insertedText.length + 64).trim()
    const sentWords = sentWindow.split(/\s+/u).slice(0, sourceWords.length)
    const differences = sourceWords
      .map((source, index) => ({ source, replacement: sentWords[index] ?? '' }))
      .filter(({ source, replacement }) => source !== replacement)
    if (differences.length !== 1) return null
    const difference = differences[0]
    if (!difference || !difference.replacement || difference.source.length > 80) return null
    if (!/^[\p{L}\p{N}'’._-]+$/u.test(difference.source)) return null
    if (!/^[\p{L}\p{N}'’._-]+$/u.test(difference.replacement)) return null

    const now = observation.sentAt
    const existing = this.index.rules.find(
      (rule) =>
        rule.kind === 'vocabulary' &&
        sameScope(rule.scope, span.scope) &&
        rule.source.toLocaleLowerCase() === difference.source.toLocaleLowerCase() &&
        rule.replacement === difference.replacement
    )
    if (existing) {
      existing.evidenceCount += 1
      existing.confidence = Math.min(0.99, 0.65 + existing.evidenceCount * 0.1)
      existing.lastReinforcedAt = now
      existing.updatedAt = now
      await this.persist()
      return structuredClone(existing)
    }
    const rule: SpeechCorrectionRule = {
      id: randomUUID(),
      kind: 'vocabulary',
      scope: structuredClone(span.scope),
      source: difference.source,
      replacement: difference.replacement,
      confidence: 0.75,
      evidenceCount: 1,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      lastReinforcedAt: now
    }
    this.index.rules.push(rule)
    this.enforceLimits(span.scope)
    await this.persist()
    return structuredClone(rule)
  }

  async setEnabled(ruleId: string, enabled: boolean): Promise<SpeechCorrectionRule> {
    const rule = this.requireRule(ruleId)
    rule.enabled = enabled
    rule.updatedAt = Date.now()
    await this.persist()
    return structuredClone(rule)
  }

  async delete(ruleId: string): Promise<void> {
    this.requireRule(ruleId)
    this.index.rules = this.index.rules.filter((rule) => rule.id !== ruleId)
    await this.persist()
  }

  private enforceLimits(scope: SpeechScope): void {
    const limit =
      scope.kind === 'global' ? MAX_GLOBAL_CORRECTION_RULES : MAX_CONTEXT_CORRECTION_RULES
    const scoped = this.index.rules
      .filter((rule) => sameScope(rule.scope, scope))
      .sort((left, right) => {
        if (left.enabled !== right.enabled) return left.enabled ? 1 : -1
        if (left.confidence !== right.confidence) return left.confidence - right.confidence
        return left.lastReinforcedAt - right.lastReinforcedAt
      })
    const remove = new Set(
      scoped.slice(0, Math.max(0, scoped.length - limit)).map((rule) => rule.id)
    )
    this.index.rules = this.index.rules.filter((rule) => !remove.has(rule.id))
  }

  private requireRule(ruleId: string): SpeechCorrectionRule {
    const rule = this.index.rules.find((item) => item.id === ruleId)
    if (!rule) throw new Error('Correction rule was not found.')
    return rule
  }

  private async persist(): Promise<void> {
    const payload = `${JSON.stringify(this.index, null, 2)}\n`
    this.writeTail = this.writeTail.then(() => atomicWrite(this.filePath, payload))
    await this.writeTail
  }

  private isIndex(value: unknown): value is RuleIndex {
    if (typeof value !== 'object' || value === null) return false
    const candidate = value as Record<string, unknown>
    return candidate['version'] === 1 && Array.isArray(candidate['rules'])
  }
}
