import { describe, expect, it } from 'vitest'

import {
  concludesCapabilityUnavailable,
  detectUnavailableToolCall,
  searchNudgePromptForProse
} from '../../src/main/chat/not-available-detector'

/**
 * The nudge is the app's answer to "it reached outside for something we
 * already host". It only works when it reads the words agents actually write,
 * so every claim here is copied from a real final answer or a real refusal.
 */
describe('unavailable-capability nudge', () => {
  it('catches an unqualified claim about a capability the app hosts', () => {
    // Verbatim from the run that shipped a verified-looking answer with no page
    // ever opened: it probed /Applications and node_modules, found nothing, and
    // wrote this. The old detector skipped it because the sentence never said
    // "in this session".
    for (const claim of [
      'No browser automation.',
      'No browser automation. Typecheck passes.',
      'There is no browser available.',
      'No computer use tool here.'
    ]) {
      expect(concludesCapabilityUnavailable(claim), claim).not.toBeNull()
    }
  })

  it('still catches the session-scoped forms it always caught', () => {
    for (const claim of [
      'The browser is not available in this session.',
      'I do not have a browser in this session.',
      'There are no MCP servers available in this session.'
    ]) {
      expect(concludesCapabilityUnavailable(claim), claim).not.toBeNull()
    }
  })

  it('leaves ordinary prose alone', () => {
    for (const claim of [
      'The page has no browser storage.',
      'The form has no browser prefix and no browser suffix.',
      'No capabilities were needed for this refactor.',
      'No tools are required for this change.',
      'The configuration file is not available in this session.',
      'svelte-check reports 0 errors and the route renders 200 from the dev server.'
    ]) {
      expect(concludesCapabilityUnavailable(claim), claim).toBeNull()
    }
  })

  it('names the gateway search and the notFound rule in the correction', () => {
    const claim = concludesCapabilityUnavailable('No browser automation.')
    expect(claim).not.toBeNull()
    if (!claim) return
    const prompt = searchNudgePromptForProse(claim)
    expect(prompt).toContain('cio_util_find')
    expect(prompt).toContain('notFound:true')
    expect(prompt).toContain('internal correction')
  })

  it('never treats this app’s own refusals as availability claims', () => {
    // A refused `ls /Applications` names cio_util_init and "utility_id" inside
    // its own reason, and that wording used to nudge a search about "utility"
    // on the next step, burying the refusal the agent had just been given.
    for (const error of [
      'Not executed: launching your own browser is refused while this thread has its in-app browser, so call cio_util_init with utility_id "cio:browser".',
      'Not executed: this command looks for a browser on this machine. Call cio_util_find, then cio_util_init with utility_id "cio:browser".',
      'Not executed: stopping a process from a shell command is refused in every form. Call cio_process_list instead.'
    ]) {
      expect(detectUnavailableToolCall('bash', error), error).toBeNull()
    }
  })

  it('keeps nudging a genuinely missing capability', () => {
    const claim = detectUnavailableToolCall(
      'mcp__firecrawl__scrape',
      'MCP server firecrawl is not available'
    )
    expect(claim).not.toBeNull()
    expect(claim?.target).toBe('mcp')
  })
})
