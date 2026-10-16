import type { McpTool } from '../agents/mcp-stdio-client'
export function designMotionTools(): McpTool[] {
  const location = { directory: { type: 'string' }, entry: { type: 'string' } }
  const target = {
    ...location,
    targetId: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,79}$' }
  }
  const state = {
    type: 'object',
    properties: {
      opacity: { type: 'number', minimum: 0, maximum: 1 },
      x: { type: 'number', minimum: -100, maximum: 100 },
      y: { type: 'number', minimum: -100, maximum: 100 },
      scale: { type: 'number', minimum: 0.5, maximum: 1.5 },
      rotate: { type: 'number', minimum: -180, maximum: 180 }
    },
    additionalProperties: false
  }
  const motion = {
    type: 'object',
    properties: {
      purpose: { enum: ['feedback', 'continuity', 'attention'] },
      trigger: { enum: ['enter', 'hover', 'press', 'focus'] },
      frequency: { enum: ['frequent', 'occasional'] },
      duration: { enum: ['immediate', 'feedback', 'control', 'reveal'] },
      easing: { enum: ['ease-out', 'ease-in-out', 'linear'] },
      from: state,
      to: state
    },
    required: ['purpose', 'trigger', 'frequency', 'duration', 'easing', 'from', 'to'],
    additionalProperties: false
  }
  const tool = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[]
  ): McpTool => ({
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false }
  })
  return [
    tool(
      'motion-read',
      'Read a unique HTML element id and current source revision before a motion edit. Returns the current authored motion style. Add a stable unique id to source first if the selected element lacks one.',
      target,
      ['directory', 'entry', 'targetId']
    ),
    ...['preview', 'apply'].map((action) =>
      tool(
        `motion-${action}`,
        action === 'preview'
          ? 'Preview motion in this thread’s browser without writing source. Read first and pass its revision. x/y use rem; rotation uses degrees. Preview survives only until reload.'
          : 'Apply motion to one unique source id with revision conflict protection, baseline/completed checkpoints and atomic write. Preserves other markup. Existing project history provides undo. Read first; preview and inspect before applying.',
        { ...target, revision: { type: 'string' }, motion },
        ['directory', 'entry', 'targetId', 'revision', 'motion']
      )
    ),
    tool(
      'motion-inspect',
      'Observe up to 100 Web Animations API effects twice in the current screen, with visible targets, properties, durations, loops and current reduced-motion preference. No FPS or canvas measurement. Sampling ends automatically. Exercise the desired interaction with browser tools first.',
      { ...location, sampleMs: { type: 'number', minimum: 0, maximum: 2000 } },
      ['directory', 'entry']
    )
  ]
}
