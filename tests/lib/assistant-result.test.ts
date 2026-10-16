import { describe, expect, it } from 'vitest'
import { assistantResultText, ASSISTANT_INVALID_RESULT } from '$shared/assistant-result'
import { buildAssistantReportDocument } from '$shared/assistant-reports'

const result =
  'Both sites are online. Google Search Console and LinkedIn need sign-in. X API credits are depleted; public profiles remain readable.'
const wire = `The user wants a monitoring report. Let me draft it.\n\n<assistant_result>${result}</assistant_result>\n\nUnrequested translated report goes here.`

describe('assistant result delivery', () => {
  it('delivers only the final marked update, excluding planning and duplicate translations', () => {
    expect(assistantResultText(wire)).toBe(result)
  })
  it('uses the newest result instead of an earlier draft', () => {
    expect(assistantResultText(`<assistant_result>Draft</assistant_result>\n${wire}`)).toBe(result)
  })
  it('never flashes preamble or partial marker text during streaming', () => {
    expect(assistantResultText('The user wants a monitoring report', true)).toBe('')
    expect(assistantResultText('<assistant_res', true)).toBe('')
    expect(
      assistantResultText('Draft\n<assistant_result>Both sites are online.</assistant_r', true)
    ).toBe('Both sites are online.')
  })
  it('returns an honest failure for empty results or incomplete opening markers', () => {
    for (const raw of ['<assistant_result></assistant_result>', '<assistant_result']) {
      expect(assistantResultText(raw)).toBe(ASSISTANT_INVALID_RESULT)
    }
  })
  it('accepts end-of-message as the closing boundary for a brief result', () => {
    expect(assistantResultText(`<assistant_result>${result}`)).toBe(result)
    expect(assistantResultText(`<assistant_result>${'word '.repeat(81)}`)).toBe(
      ASSISTANT_INVALID_RESULT
    )
  })
  it('refuses an overlong default result without silently cutting off its contents', () => {
    expect(assistantResultText(`<assistant_result>${'word '.repeat(81)}</assistant_result>`)).toBe(
      ASSISTANT_INVALID_RESULT
    )
    expect(assistantResultText(`<assistant_result>${'word '.repeat(80)}</assistant_result>`)).toBe(
      'word '.repeat(80).trim()
    )
  })
  it('preserves an explicitly requested detailed answer and existing unmarked reports', () => {
    const detail = 'Important detail. '.repeat(100).trim()
    expect(assistantResultText(`<assistant_detail>${detail}</assistant_detail>`)).toBe(detail)
    expect(assistantResultText(detail)).toBe(detail)
    expect(assistantResultText(result)).toBe(result)
  })
  it('recognizes the reported drafting preamble instead of presenting it as a result', () => {
    expect(assistantResultText('Now write the report.\nDraft:\n' + result)).toBe(
      ASSISTANT_INVALID_RESULT
    )
  })
  it('archives exactly the same delivered update without model drafting or delimiters', () => {
    const document = buildAssistantReportDocument({
      taskTitle: 'Watch products',
      report: wire,
      status: 'completed',
      at: 0
    })
    expect(document).toContain(result)
    expect(document).not.toContain('Let me draft')
    expect(document).not.toContain('translated report')
    expect(document).not.toContain('assistant_result')
  })
})
