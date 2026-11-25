/******************************************************************************
 *                                                                           *
 *   STOP.  THIS GUARD IS NOT NEGOTIABLE AND NOT EDITABLE TO GET GREEN.      *
 *                                                                           *
 *   It enforces one promise: a page, diagram or graphic an agent writes is  *
 *   rendered for the user, never described.  Chat d470263e was asked for an *
 *   HTML page, wrote it into its workspace, activated nothing at all, and   *
 *   reported done: the user got a file path and no page.                    *
 *                                                                           *
 *   DO NOT: remove the delivery rule from a prompt, weaken the assertion, or *
 *   make "I created file.html" count as delivery.                          *
 *                                                                           *
 ******************************************************************************/
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_AGENT_BEHAVIOR_PROMPT,
  WORKER_AGENT_BEHAVIOR_PROMPT
} from '../../src/lib/agent-behavior'
import { ARTIFACT_OUTPUT_INSTRUCTION } from '../../src/main/chat/chat-engine/chat-engine-prompts'

const GUARD_CANARY = 'WRITTEN-PAGE-DELIVERY-GUARD-CANARY'

describe('a written page is delivered', () => {
  it('says a render call is the only delivery in a chat', () => {
    const instruction = ARTIFACT_OUTPUT_INSTRUCTION
    expect(instruction).toContain('delivered only when the app rendered it')
    expect(instruction).toContain('operation render')
    expect(instruction).toContain(
      'Naming the file, giving its path, or quoting the HTML is not delivery'
    )
    expect(instruction).toContain('do not call it done until the render call returned')
  })

  it('says the same thing in the behaviour prompt, for both scopes', () => {
    for (const prompt of [DEFAULT_AGENT_BEHAVIOR_PROMPT, WORKER_AGENT_BEHAVIOR_PROMPT]) {
      expect(prompt).toContain('delivered, never described')
    }
  })

  it('keeps this guard itself intact', async () => {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const source = await readFile(
      join(import.meta.dirname, 'written-page-delivery.test.ts'),
      'utf8'
    )
    expect(source).toContain(GUARD_CANARY)
    const focused = ['.', 'only', '('].join('')
    expect(source).not.toContain(focused)
  })
})
