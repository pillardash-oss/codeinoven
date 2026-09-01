import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const repoRoot = new URL('../../../', import.meta.url)

function readRepoFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, repoRoot), 'utf8')
}

const componentSource = readRepoFile(
  'src/renderer/lib/components/settings/ProfileSettingsTab.svelte'
)

describe('ProfileSettingsTab model-ranking presentation', () => {
  it('renders separate one-shot and multi-shot columns with samples and timing', () => {
    expect(componentSource).toMatch(/model-ranking-heading/)
    expect(componentSource).toContain('One-shot')
    expect(componentSource).toContain('Multi-shot')
    expect(componentSource).toContain('Configuration')
    expect(componentSource).toMatch(/rankingScoreLabel\(/)
    expect(componentSource).toMatch(/rankingSamplesLabel\(/)
    expect(componentSource).toMatch(/rankingDurationLabel\(/)
    expect(componentSource).toMatch(/gradingSpend/)
    expect(componentSource).toMatch(/modelRankings/)
  })

  it('surfaces the rubric version per row without leaking rubric descriptors', () => {
    expect(componentSource).toMatch(/entry\.rubricVersion/)
    // Judge instruction anchors and scale wording never appear as UI copy.
    expect(componentSource).not.toMatch(/flawless/)
    expect(componentSource).not.toMatch(/very successful/)
    expect(componentSource).not.toMatch(/partially helpful/)
    expect(componentSource).not.toMatch(/actively harmful/)
    expect(componentSource).not.toMatch(/judge/i)
    expect(componentSource).not.toMatch(/USER_MESSAGE|AGENT_OUTPUT|USER_FOLLOW_UP/)
  })

  it('retires the old average-grade-of-five presentation', () => {
    expect(componentSource).not.toMatch(/modelPerformance/)
    expect(componentSource).not.toMatch(/feedbackCost/)
    expect(componentSource).not.toMatch(/TurnOutcomeTaskType/)
    expect(componentSource).not.toMatch(/successRate/)
  })
})
