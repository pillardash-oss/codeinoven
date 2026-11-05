import { describe, expect, it } from 'vitest'
import {
  CREATE_ACHIEVEMENT_TOOL_NAME,
  CREATE_ASSIGNMENT_TOOL_NAME,
  CREATE_BRAINSTORM_TOOL_NAME,
  CREATE_PRD_TOOL_NAME,
  CREATE_SPEC_TOOL_NAME,
  ENGINEERING_TOOL_NAMES,
  ENGINEERING_TOOLS,
  engineeringToolOperation
} from '../../src/lib/engineering-tools'
import { DEFAULT_AGENT_BEHAVIOR_PROMPT } from '../../src/lib/agent-behavior'
import { CIO_PROMPT_DEFINITIONS } from '../../src/lib/cio-prompts'
import {
  engineeringPendingMessage,
  engineeringStudioVisible
} from '../../src/lib/engineering-generation'
import { neutralEngineeringThreadSettings } from '../../src/lib/thread-engineering-neutral'
import { normalizeLifecycleStages } from '../../src/lib/engines/engineering-lifecycle-engine'
import type { EngineeringLifecycleStage, ThreadSettings } from '../../src/lib/types'

/**
 * Probe for the post-toolbox contract: every Engineering lifecycle stage is a
 * tool the agent turns on from the user's own words, Behavior is the only
 * editable prompt surface, and Auto Pilot no longer exists anywhere.
 */
describe('Engineering stage tools probe', () => {
  const stageTools: ReadonlyArray<{
    stage: EngineeringLifecycleStage
    toolName: string
    intents: readonly string[]
  }> = [
    {
      stage: 'brainstorm',
      toolName: CREATE_BRAINSTORM_TOOL_NAME,
      intents: ['brainstorm', 'explore an idea']
    },
    {
      stage: 'prd',
      toolName: CREATE_PRD_TOOL_NAME,
      intents: ['PRD', 'product requirements']
    },
    {
      stage: 'spec',
      toolName: CREATE_SPEC_TOOL_NAME,
      intents: ['spec', 'implementation plan']
    },
    {
      stage: 'assignment',
      toolName: CREATE_ASSIGNMENT_TOOL_NAME,
      intents: ['split this into tasks', 'assign workers or agents']
    },
    {
      stage: 'achievement',
      toolName: CREATE_ACHIEVEMENT_TOOL_NAME,
      intents: ['until the goal is reached', 'keep going until it works']
    }
  ]

  it('exposes one callable artifact tool per lifecycle stage', () => {
    expect([...ENGINEERING_TOOL_NAMES].sort()).toEqual(
      stageTools.map((entry) => entry.toolName).sort()
    )
    for (const entry of stageTools) {
      expect(engineeringToolOperation(entry.toolName)).toBe(entry.stage)
      const tool = ENGINEERING_TOOLS.find((candidate) => candidate.name === entry.toolName)
      expect(tool, `${entry.toolName} must be in the catalog`).toBeDefined()
      expect(tool?.route).toMatch(/^\/engineering\//u)
      expect(tool?.description.trim().length ?? 0).toBeGreaterThan(80)
    }
  })

  it('teaches the behavior prompt every intent-to-tool mapping', () => {
    for (const entry of stageTools) {
      expect(DEFAULT_AGENT_BEHAVIOR_PROMPT).toContain(entry.toolName)
      for (const intent of entry.intents) {
        expect(
          DEFAULT_AGENT_BEHAVIOR_PROMPT.toLowerCase(),
          `${entry.toolName} should be reachable from "${intent}"`
        ).toContain(intent.toLowerCase())
      }
    }
    expect(DEFAULT_AGENT_BEHAVIOR_PROMPT).toContain('Engineering stages')
    expect(DEFAULT_AGENT_BEHAVIOR_PROMPT).not.toContain('Engineering Toolbox')
    expect(DEFAULT_AGENT_BEHAVIOR_PROMPT).not.toContain('Auto Pilot')
  })

  it('keeps Behavior to work ethics and the PR review brief only', () => {
    expect(CIO_PROMPT_DEFINITIONS.map((definition) => definition.id)).toEqual([
      'work-ethics',
      'pr-review'
    ])
    for (const definition of CIO_PROMPT_DEFINITIONS) {
      expect(definition.defaultTemplate).not.toContain('Auto Pilot')
      expect(definition.defaultTemplate).not.toContain('Engineering Toolbox')
    }
  })

  it('still cascades the Achievement dependency onto Spec', () => {
    expect(normalizeLifecycleStages(['achievement'])).toEqual(['spec', 'achievement'])
    expect(normalizeLifecycleStages(['assignment'])).toEqual(['assignment'])
  })

  it('offers the studio while a tool-started stage is still generating', () => {
    // The bug this covers: an agent initiated a spec or Assignment itself, and
    // the studio stayed hidden until the document existed.
    expect(
      engineeringStudioVisible({
        chatMode: false,
        hasDocument: false,
        retryable: false,
        generationInFlight: 'spec'
      })
    ).toBe(true)
    expect(
      engineeringStudioVisible({
        chatMode: false,
        hasDocument: false,
        retryable: false,
        generationInFlight: 'assignment'
      })
    ).toBe(true)
    // Nothing to show and nothing running stays hidden.
    expect(
      engineeringStudioVisible({
        chatMode: false,
        hasDocument: false,
        retryable: false,
        generationInFlight: null
      })
    ).toBe(false)
    // A chat never gets an Engineering studio.
    expect(
      engineeringStudioVisible({
        chatMode: true,
        hasDocument: true,
        retryable: false,
        generationInFlight: 'spec'
      })
    ).toBe(false)
  })

  it('says the agent is still working instead of rendering an empty document', () => {
    for (const stage of ['spec', 'assignment'] as const) {
      const message = engineeringPendingMessage(stage)
      expect(message).toContain('Nothing has been generated yet')
      expect(message).toContain('still working')
    }
    expect(engineeringPendingMessage(null)).toBeNull()
  })

  it('starts a new thread neutral instead of inheriting Engineering modes', () => {
    // A sibling created beside an Engineering thread must not arrive already in
    // Assignment or Achievement mode, and no stage selection travels with it.
    const inherited: ThreadSettings = {
      harnessId: 'pi',
      providerId: 'opencode-go',
      modelId: 'deepseek-v4.1-flash',
      thinkingLevel: 'low',
      permissionLevel: 'auto_review',
      assignmentMode: true,
      loopMode: true
    }
    const neutral = neutralEngineeringThreadSettings(inherited)
    expect(neutral.assignmentMode).toBe(false)
    expect(neutral.loopMode).toBe(false)
    // The user's own configuration still travels.
    expect(neutral.harnessId).toBe(inherited.harnessId)
    expect(neutral.providerId).toBe(inherited.providerId)
    expect(neutral.modelId).toBe(inherited.modelId)
    expect(neutral.permissionLevel).toBe(inherited.permissionLevel)
  })
})
