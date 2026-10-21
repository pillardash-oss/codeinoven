import type { McpTool } from '../../agents/mcp-stdio-client'
import { VIDEO_REVIEW_EVIDENCE_SCHEMA } from '../../../lib/video/review'

/** The shared rubric keeps screen and film assessments on the same score scale. */
export function authoredWorkCritiqueTool(kind: 'design' | 'video' = 'design'): McpTool {
  const tool = {
    name: 'critique',
    description:
      'Record one evidence-based screen critique after rendering it. Scores philosophy, hierarchy, detail, functionality and innovation equally, 0 to 10; threshold 8. Any craft finding or critical issue blocks passing. Persists model-attributed scores for Usage; repeated assessment of identical content does not add a sample.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string' },
        entry: { type: 'string' },
        ...(kind === 'video' ? { reviewEvidence: VIDEO_REVIEW_EVIDENCE_SCHEMA } : {}),
        dimensions: {
          type: 'object',
          properties: Object.fromEntries(
            ['philosophy', 'hierarchy', 'detail', 'functionality', 'innovation'].map((name) => [
              name,
              {
                type: 'object',
                properties: {
                  score: { type: 'number', minimum: 0, maximum: 10 },
                  evidence: { type: 'string', minLength: 1, maxLength: 2000 }
                },
                required: ['score', 'evidence'],
                additionalProperties: false
              }
            ])
          ),
          required: ['philosophy', 'hierarchy', 'detail', 'functionality', 'innovation'],
          additionalProperties: false
        },
        fixes: { type: 'array', items: { type: 'string', maxLength: 1000 }, maxItems: 30 },
        criticalIssues: {
          type: 'array',
          items: { type: 'string', maxLength: 1000 },
          maxItems: 30
        }
      },
      required: [
        'directory',
        'entry',
        'dimensions',
        'fixes',
        'criticalIssues',
        ...(kind === 'video' ? ['reviewEvidence'] : [])
      ],
      additionalProperties: false
    }
  }
  if (kind === 'video') {
    tool.description =
      'Record an agent-assessed video critique after inspecting opening, middle and closing frames, watching playback and checking audio or intentional silence. Score philosophy, hierarchy, detail, functionality and innovation equally from 0 to 10, threshold 8. Critical issues block passing. Saves a source-bound video-v1 report; identical source/model/rubric updates one sample. This does not approve an exported MP4.'
  }
  return tool
}
