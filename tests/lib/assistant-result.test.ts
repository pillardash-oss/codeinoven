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
  })
  it('delivers an overlong result instead of replacing it with a retry message', () => {
    // Brevity is guidance, not a gate: a longer update is still the update the
    // user needs, so it is shown rather than swapped for ASSISTANT_INVALID_RESULT.
    const long = 'word '.repeat(81).trim()
    expect(assistantResultText(`<assistant_result>${long}</assistant_result>`)).toBe(long)
    expect(assistantResultText(`<assistant_result>${long}`)).toBe(long)
    expect(assistantResultText(`<assistant_result>${'word '.repeat(90)}`, true)).toBe(
      'word '.repeat(90).trim()
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
  it('drops a leading urgency tag the run was never meant to write', () => {
    // Urgency is the run's own guidance, so a bracket or label prefix is noise a
    // user reported seeing. Both the stored ids and their display labels go.
    expect(assistantResultText('[whenever · just-me] Both sites are online.')).toBe(
      'Both sites are online.'
    )
    expect(assistantResultText('[Whenever · Just me] Both sites are online.')).toBe(
      'Both sites are online.'
    )
    expect(
      assistantResultText('<assistant_result>[today · company] Ship it.</assistant_result>')
    ).toBe('Ship it.')
    // A sentence that merely starts with a bracket-free word stays untouched.
    expect(assistantResultText('Today both sites are online.')).toBe('Today both sites are online.')
    expect(assistantResultText(result)).toBe(result)
  })
  it('archives exactly the same delivered update without model drafting or delimiters', () => {
    const document = buildAssistantReportDocument({
      title: 'Watch products',
      taskTitle: 'Watch products',
      report: wire,
      status: 'completed',
      at: 0
    })
    // The heading is the run's own title, not a label the app invented for it.
    expect(document.startsWith('# Watch products')).toBe(true)
    expect(document).toContain(result)
    expect(document).not.toContain('Let me draft')
    expect(document).not.toContain('translated report')
    expect(document).not.toContain('assistant_result')
  })
})
