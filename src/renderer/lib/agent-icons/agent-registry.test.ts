import { describe, expect, it } from 'vitest'
import { buildAgentIconEntry, normalizeAgentIconId, parseAgentIconMetadata } from './agent-registry'
import { agentIconRegistry, getAgentIcon } from './registry'

describe('agent icon metadata', () => {
  it('normalizes IDs and rejects incomplete metadata', () => {
    expect(normalizeAgentIconId(' OpenAI_Codex ')).toBe('openai-codex')
    expect(parseAgentIconMetadata({ id: 'codex', name: 'Codex' })).toBeUndefined()
  })

  it('resolves icon assets inside the public registry path', () => {
    const metadata = parseAgentIconMetadata({
      id: 'codex',
      name: 'Codex',
      vendor: 'OpenAI',
      website: 'https://developers.openai.com/codex',
      icon: '../_placeholder.svg',
      aliases: ['openai-codex']
    })
    expect(metadata).toBeDefined()
    expect(buildAgentIconEntry(metadata!).iconUrl).toBe('/assets/agents/_placeholder.svg')
  })

  it('loads every metadata folder without a handwritten registry list', () => {
    expect(agentIconRegistry).toHaveLength(7)
    expect(getAgentIcon('openai-codex')?.id).toBe('codex')
    expect(getAgentIcon('roo')).toBeUndefined()
    expect(getAgentIcon('pi')?.name).toBe('Pi')
    expect(getAgentIcon('agy')?.id).toBe('antigravity')
    expect(getAgentIcon('muse')?.name).toBe('Muse Code')
    expect(getAgentIcon('meta')?.id).toBe('muse')
  })
})
