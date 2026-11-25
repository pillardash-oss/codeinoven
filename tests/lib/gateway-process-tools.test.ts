import { describe, expect, it } from 'vitest'

import {
  PROCESS_LIST_TOOL_NAME,
  PROCESS_START_TOOL_NAME,
  PROCESS_STOP_TOOL_NAME,
  processDirectToolsForQuery
} from '../../src/lib/gateway-tools'

/**
 * A process question must be answered with the app's process tools.
 *
 * A thread asked for "process lifecycle: list and stop a process the session
 * started"; the search answered with unrelated utilities and no mention of the
 * three app-owned tools, so the model concluded no process lifecycle existed
 * and left a dev server it had started itself running. That is the regression
 * these assertions hold: the tools are never absent from the answer, and the
 * answer says they are called directly rather than activated.
 */
describe('process tools in a capability search', () => {
  it('names all three app-owned process tools for a process question', () => {
    const tools = processDirectToolsForQuery(
      'process lifecycle: list and stop a process the session started'
    )
    expect(tools.map(({ id }) => id)).toEqual([
      PROCESS_LIST_TOOL_NAME,
      PROCESS_START_TOOL_NAME,
      PROCESS_STOP_TOOL_NAME
    ])
  })

  it('says they are called directly, never activated', () => {
    for (const tool of processDirectToolsForQuery('stop the dev server on port 5173')) {
      expect(tool.callDirectly).toBe(true)
      expect(tool.kind).toBe('tool')
      expect(tool.description).toContain('call it directly')
      expect(tool.description).toContain('not a utility')
    }
  })

  it('answers the phrasings a model actually types', () => {
    for (const query of [
      'how do I stop the server I started',
      'kill the dev server',
      'which processes are running in the background',
      'shut down the watcher',
      'daemon lifecycle'
    ]) {
      expect(processDirectToolsForQuery(query), query).toHaveLength(3)
    }
  })

  it('stays out of a search that is not about a process', () => {
    for (const query of ['svelte documentation', 'postgres backup', 'image descriptor']) {
      expect(processDirectToolsForQuery(query), query).toEqual([])
    }
  })
})
