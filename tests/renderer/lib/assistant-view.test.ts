import { describe, expect, it } from 'vitest'
import {
  TASK_RUN_PREVIEW,
  UNGROUPED_MISSED_RUNS,
  assistantSubjectName,
  connectionsFromPlan,
  extractKnowledgeDraft,
  extractAssistantPlanDraft,
  groupMissedRunsByAssistant,
  groupRunsByAssistant,
  groupRunsByTask,
  handoffSummary,
  isAssistantConfirmation,
  assistantGap,
  assistantSiblingRuns,
  latestKnowledgeDraft,
  latestAssistantPlanDraft,
  missedTabVisible,
  parseKnowledgeSections,
  parsePlanTime,
  parseAssistantPlan,
  previewRuns,
  resolveConnections,
  runRowLine,
  serializeKnowledgeSections,
  taskHasMissed,
  taskRowIconKey,
  taskRunLine
} from '$lib/components/assistant/assistant-view'
import {
  ASSISTANT_PLAN_JSON_SCHEMA,
  parseAssistantPlanJson,
  parseAssistantPlanValue
} from '$shared/assistant-plan'
import { STATUS_TONE_COLORS } from '$lib/stores/scope-board'
import { STATUS_TONE_COLORS as STATUS_TONE_COLORS_VIA_SCOPE } from '$lib/stores/scope.svelte'
import { THREAD_STATUS_POLICY } from '$shared/thread-status-policy'
import type {
  MissedRun,
  AssistantConnection,
  UtilityCatalog,
  UtilityDefinitionFor
} from '$shared/types'

function missedRun(overrides: Partial<MissedRun> = {}): MissedRun {
  return {
    id: 't1:123',
    threadId: 't1',
    dueAt: 123,
    detectedAt: 456,
    title: 'Task',
    status: 'pending',
    ...overrides
  }
}

describe('assistant-view presentation helpers', () => {
  it('shows the Missed runs tab only when a run was missed', () => {
    expect(missedTabVisible([])).toBe(false)
    expect(missedTabVisible([missedRun()])).toBe(true)
    expect(taskHasMissed([])).toBe(false)
    expect(taskHasMissed([missedRun()])).toBe(true)
  })

  it('groups missed runs per assistant, keeping assistant-less runs separate', () => {
    const runs = [
      missedRun({ id: 'a:1', threadId: 'a', assistantId: 'r1', title: 'A' }),
      missedRun({ id: 'b:1', threadId: 'b', assistantId: 'r2', title: 'B' }),
      missedRun({ id: 'c:1', threadId: 'c', title: 'C' }),
      missedRun({ id: 'a:2', threadId: 'a', assistantId: 'r1', title: 'A again' })
    ]
    const groups = groupMissedRunsByAssistant(
      runs,
      new Map([
        ['r1', 'Daily PR triage'],
        ['r2', 'Morning inbox report']
      ])
    )
    expect(groups.map((group) => group.key)).toEqual(['r1', 'r2', UNGROUPED_MISSED_RUNS])
    expect(groups.map((group) => group.label)).toEqual([
      'Daily PR triage',
      'Morning inbox report',
      'Tasks without an assistant'
    ])
    // Runs of one assistant stay together, in store order.
    expect(groups[0].runs.map((run) => run.id)).toEqual(['a:1', 'a:2'])
  })

  it('falls back to a neutral assistant label when the assistant name is unknown', () => {
    const [group] = groupMissedRunsByAssistant(
      [missedRun({ id: 'x:1', threadId: 'x', assistantId: 'missing' })],
      new Map()
    )
    expect(group.label).toBe('Assistant')
  })

  it('renders next-run first, then last-run, then Not scheduled', () => {
    const now = new Date(2026, 2, 10, 10, 0).getTime()
    const anHourLater = now + 60 * 60 * 1000
    expect(taskRunLine({ lastRunAt: now - 1000 }, anHourLater, now)).toBe('Next run in 1h')
    expect(taskRunLine({ lastRunAt: now - 60 * 60 * 1000 }, null, now)).toBe('Last run 1h ago')
    expect(taskRunLine({}, null, now)).toBe('Not scheduled')
  })

  it('uses a custom task icon only when one is set', () => {
    expect(taskRowIconKey({ assistantIconType: 'code' })).toBe('custom')
    expect(taskRowIconKey({})).toBe('task')
  })

  it('gives an assistant knowledge thread its own icon, custom still winning', () => {
    expect(taskRowIconKey({ assistantGettingStarted: true })).toBe('knowledge')
    expect(taskRowIconKey({ assistantGettingStarted: true, assistantIconType: 'code' })).toBe(
      'custom'
    )
  })

  it('marks a run thread as a run, never as a task or a knowledge thread', () => {
    expect(taskRowIconKey({ assistantTaskId: 'task-1' })).toBe('run')
    // A run is never a custom-icon row, but a custom icon still wins if one is set.
    expect(taskRowIconKey({ assistantTaskId: 'task-1', assistantIconType: 'code' })).toBe('custom')
    expect(taskRowIconKey({ assistantTaskId: 'task-1', assistantGettingStarted: true })).toBe('run')
  })

  it('renders a run row line 2 as how long ago that run last did anything', () => {
    const now = new Date(2026, 2, 10, 10, 0).getTime()
    expect(runRowLine({ lastActivity: now - 5 * 60_000 }, now)).toBe('Ran 5m ago')
    expect(runRowLine({ lastActivity: now }, now)).toBe('Ran now')
  })

  it('groups runs under their task, newest first, and leaves tasks out', () => {
    const grouped = groupRunsByTask([
      { id: 'task-1', createdAt: 1 },
      { id: 'run-old', assistantTaskId: 'task-1', createdAt: 10 },
      { id: 'run-new', assistantTaskId: 'task-1', createdAt: 30 },
      { id: 'other-run', assistantTaskId: 'task-2', createdAt: 20 }
    ])
    expect([...grouped.keys()]).toEqual(['task-1', 'task-2'])
    expect(grouped.get('task-1')?.map((run) => run.id)).toEqual(['run-new', 'run-old'])
    expect(grouped.get('task-2')?.map((run) => run.id)).toEqual(['other-run'])
  })

  it('bounds a task row to the newest runs until the user asks for all', () => {
    const runs = [1, 2, 3, 4, 5].map((n) => ({ id: `run-${n}` }))
    expect(previewRuns(runs, false)).toHaveLength(TASK_RUN_PREVIEW)
    expect(previewRuns(runs, false).map((run) => run.id)).toEqual(['run-1', 'run-2', 'run-3'])
    expect(previewRuns(runs, true)).toHaveLength(5)
  })

  it('groups runs under their assistant, newest first, leaving routineless runs out', () => {
    const grouped = groupRunsByAssistant([
      { id: 'seed', createdAt: 1 },
      { id: 'run-old', assistantTaskId: 'task-1', assistantId: 'r1', createdAt: 10 },
      { id: 'run-new', assistantTaskId: 'task-2', assistantId: 'r1', createdAt: 30 },
      { id: 'loose-run', assistantTaskId: 'task-3', createdAt: 40 },
      { id: 'other-run', assistantTaskId: 'task-4', assistantId: 'r2', createdAt: 20 }
    ])
    expect([...grouped.keys()]).toEqual(['r1', 'r2'])
    expect(grouped.get('r1')?.map((run) => run.id)).toEqual(['run-new', 'run-old'])
    expect(grouped.get('r2')?.map((run) => run.id)).toEqual(['other-run'])
  })

  it('keeps a setting-up assistant’s runs nested inside Getting started', () => {
    const runs = [
      { id: 'run-new', assistantTaskId: 'seed', assistantId: 'r1', createdAt: 30 },
      { id: 'run-old', assistantTaskId: 'seed', assistantId: 'r1', createdAt: 10 }
    ]
    const tasksById = new Map([['seed', { assistantGettingStarted: true }]])
    const rendered = new Set(['seed'])
    expect(assistantSiblingRuns(runs, false, rendered, tasksById)).toEqual([])
  })

  it('moves a set-up assistant’s Getting started runs beside it, newest first', () => {
    const runs = [
      { id: 'run-old', assistantTaskId: 'seed', assistantId: 'r1', createdAt: 10 },
      { id: 'run-new', assistantTaskId: 'seed', assistantId: 'r1', createdAt: 30 }
    ]
    const tasksById = new Map([['seed', { assistantGettingStarted: true }]])
    const rendered = new Set(['seed'])
    expect(assistantSiblingRuns(runs, true, rendered, tasksById).map((run) => run.id)).toEqual([
      'run-new',
      'run-old'
    ])
  })

  it('hoists a hidden task’s runs, but never one whose task nests elsewhere', () => {
    const runs = [
      { id: 'pinned-task-run', assistantTaskId: 'pinned-task', assistantId: 'r1', createdAt: 5 },
      { id: 'hidden-seed-run', assistantTaskId: 'hidden-seed', assistantId: 'r1', createdAt: 15 }
    ]
    // The pinned task stays on screen (in the Pinned section), so its run is
    // not rendered under the assistant; the hidden seed is not on screen at all.
    const tasksById = new Map([['pinned-task', { assistantGettingStarted: false }]])
    const rendered = new Set<string>()
    expect(assistantSiblingRuns(runs, true, rendered, tasksById).map((run) => run.id)).toEqual([
      'hidden-seed-run'
    ])
  })
})

describe('assistant subject naming', () => {
  const task = { title: 'Slack digest', assistantGettingStarted: false }
  const setup = { title: 'Getting started', assistantGettingStarted: true }

  it('names a run for the task it ran', () => {
    expect(assistantSubjectName(task, 'Morning assistant', 'fallback')).toBe('Slack digest')
  })

  it('never reports the Getting started authoring host as a job name', () => {
    // A run of the seed task is named for its assistant, so a saved assistant's
    // runs never read as another getting-started pass.
    expect(assistantSubjectName(setup, 'Morning assistant', 'fallback')).toBe('Morning assistant')
  })

  it('falls back to the assistant when the task row is gone', () => {
    expect(assistantSubjectName(undefined, 'Morning assistant', 'Assistant run')).toBe(
      'Morning assistant'
    )
  })

  it('uses the fallback only when neither task nor assistant is known', () => {
    expect(assistantSubjectName(undefined, null, 'Assistant run')).toBe('Assistant run')
    expect(assistantSubjectName(setup, null, 'Assistant task')).toBe('Assistant task')
  })
})

describe('missed status tone', () => {
  it('maps the missed tone to its dedicated token in both scope-board and the scope barrel', () => {
    expect(STATUS_TONE_COLORS.missed).toBe('var(--color-missed)')
    expect(STATUS_TONE_COLORS_VIA_SCOPE.missed).toBe('var(--color-missed)')
  })

  it('never maps a thread status to the missed tone', () => {
    for (const policy of Object.values(THREAD_STATUS_POLICY)) {
      expect(policy.tone).not.toBe('missed')
    }
  })

  it('does not reuse the warning token for missed', () => {
    expect(STATUS_TONE_COLORS.missed).not.toBe(STATUS_TONE_COLORS.attention)
  })
})

describe('knowledge draft extraction', () => {
  it('reads a bare fence whose body starts with a knowledge title line', () => {
    const message = [
      'Here is the exact instruction set for the assistant.',
      '',
      '```',
      'knowledge: Slack checkup drain',
      '',
      'GOAL',
      'Twice a day, sweep every Slack conversation.',
      '```',
      '',
      'Send /save-knowledge to commit this.'
    ].join('\n')
    expect(extractKnowledgeDraft(message)).toBe(
      'GOAL\nTwice a day, sweep every Slack conversation.'
    )
  })

  it('reads a fence tagged knowledge with or without a trailing title', () => {
    expect(extractKnowledgeDraft('```knowledge\nCheck email at 08:30.\n```')).toBe(
      'Check email at 08:30.'
    )
    expect(extractKnowledgeDraft('```knowledge: Morning mail\nCheck email at 08:30.\n```')).toBe(
      'Check email at 08:30.'
    )
    expect(extractKnowledgeDraft('```knowledge\nCheck email.\n```')).toBe('Check email.')
    expect(extractKnowledgeDraft('```Knowledge - Morning mail\nCheck email.\n```')).toBe(
      'Check email.'
    )
  })

  it('strips the marker line when the fence carries both a tag and a title line', () => {
    expect(
      extractKnowledgeDraft('```knowledge\nknowledge: Morning mail\n\nCheck email at 08:30.\n```')
    ).toBe('Check email at 08:30.')
  })

  it('ignores blocks and messages that carry no knowledge', () => {
    expect(extractKnowledgeDraft('No code block here at all.')).toBeNull()
    expect(extractKnowledgeDraft('```ts\nconst x = 1\n```')).toBeNull()
    expect(extractKnowledgeDraft('```json\n{"knowledge": "not a block"}\n```')).toBeNull()
    expect(extractKnowledgeDraft('```\nknowledge: title only\n```')).toBeNull()
  })

  it('takes the newest knowledge block in a message', () => {
    const message = ['```knowledge\nFirst draft.\n```', '```knowledge\nSecond draft.\n```'].join(
      '\n'
    )
    expect(extractKnowledgeDraft(message)).toBe('Second draft.')
  })

  it('keeps a nested command fence inside the draft instead of truncating at it', () => {
    const message = [
      '```knowledge',
      'GOAL',
      '',
      'Run this:',
      '```bash',
      'gh pr list --state open',
      '```',
      '',
      'Then summarise the result.',
      '```'
    ].join('\n')
    expect(extractKnowledgeDraft(message)).toBe(
      [
        'GOAL',
        '',
        'Run this:',
        '```bash',
        'gh pr list --state open',
        '```',
        '',
        'Then summarise the result.'
      ].join('\n')
    )
  })

  it('keeps nested fences in a four-backtick block and excludes trailing prose', () => {
    const message = [
      '````knowledge',
      'GOAL',
      '```bash',
      'ls',
      '```',
      '````',
      '',
      'Send /save-knowledge to commit this.'
    ].join('\n')
    expect(extractKnowledgeDraft(message)).toBe(['GOAL', '```bash', 'ls', '```'].join('\n'))
  })

  it('stops at the knowledge block even when a later fenced block follows it', () => {
    const message = [
      '```knowledge',
      'GOAL',
      '```',
      '',
      'Send /save-knowledge.',
      '',
      '```bash',
      'ls',
      '```'
    ].join('\n')
    expect(extractKnowledgeDraft(message)).toBe('GOAL')
  })

  it('takes the newest message that holds a draft', () => {
    const texts = [
      '```knowledge\nOlder draft.\n```',
      'Still discussing the tools.',
      '```\nknowledge: Slack digest\n\nNewer draft.\n```'
    ]
    expect(latestKnowledgeDraft(texts)).toBe('Newer draft.')
    expect(latestKnowledgeDraft(['No draft yet.', '```ts\nconst x = 1\n```'])).toBeNull()
  })
})

/** A representative excerpt of an authored knowledge: ALL-CAPS titles, an
 *  indented report shape, and a numbered procedure. */
const AUTHORED_KNOWLEDGE = [
  'GOAL',
  'Sweep every Slack conversation twice a day and record what arrived.',
  '',
  'REQUIRED CAPABILITIES',
  '- The Slack MCP server tools: conversations_history, conversations_replies.',
  '  Never call conversations_add_message.',
  '',
  'LOCAL TIME',
  '- All windows use the machine clock.',
  '',
  'DRAIN PROCEDURE (0600 and 1800)',
  '1. Window: local today 06:00 up to now.',
  '2. Enumerate conversations with channels_list.',
  '',
  'STYLE AND DISCLOSURE',
  '- The report never contains tool names.'
].join('\n')

describe('knowledge section parsing', () => {
  it('splits ALL-CAPS titles, including a parenthesised one with lowercase inside', () => {
    const sections = parseKnowledgeSections(AUTHORED_KNOWLEDGE)
    expect(sections.map((section) => section.title)).toEqual([
      'GOAL',
      'REQUIRED CAPABILITIES',
      'LOCAL TIME',
      'DRAIN PROCEDURE (0600 and 1800)',
      'STYLE AND DISCLOSURE'
    ])
    expect(sections[0]?.body).toBe(
      'Sweep every Slack conversation twice a day and record what arrived.'
    )
    // The numbered procedure stays in its section instead of splitting on it.
    expect(sections[3]?.body).toContain('1. Window: local today 06:00 up to now.')
    expect(sections[3]?.body).toContain('2. Enumerate conversations with channels_list.')
  })

  it('round-trips an authored knowledge through serialize', () => {
    const sections = parseKnowledgeSections(AUTHORED_KNOWLEDGE)
    expect(serializeKnowledgeSections(sections)).toBe(AUTHORED_KNOWLEDGE)
  })

  it('splits markdown headings and keeps fenced content intact', () => {
    const markdown = [
      '# Assistant',
      'Intro line.',
      '',
      '## Steps',
      'Run this:',
      '',
      '```bash',
      '## NOT A HEADING',
      'ls',
      '```',
      '',
      '## Notes',
      'Done.'
    ].join('\n')
    const sections = parseKnowledgeSections(markdown)
    expect(sections.map((section) => section.title)).toEqual(['Assistant', 'Steps', 'Notes'])
    expect(sections[1]?.body).toContain('## NOT A HEADING')
    expect(serializeKnowledgeSections(sections)).toBe(markdown)
  })

  it('treats a heading-less knowledge as one Instructions section', () => {
    const sections = parseKnowledgeSections('Just do the thing, twice.')
    expect(sections).toHaveLength(1)
    expect(sections[0]?.title).toBe('Instructions')
    expect(sections[0]?.heading).toBe('')
    expect(serializeKnowledgeSections(sections)).toBe('Just do the thing, twice.')
    expect(parseKnowledgeSections('   ')).toEqual([])
  })
})

describe('assistant plan parsing', () => {
  it('normalises every accepted time shape', () => {
    expect(parsePlanTime('8')).toBe('08:00')
    expect(parsePlanTime('8:30')).toBe('08:30')
    expect(parsePlanTime('8am')).toBe('08:00')
    expect(parsePlanTime('8:30 pm')).toBe('20:30')
    expect(parsePlanTime('12am')).toBe('00:00')
    expect(parsePlanTime('18:00')).toBe('18:00')
    expect(parsePlanTime('1800')).toBeNull()
    expect(parsePlanTime('25:00')).toBeNull()
  })

  it('reads cadence, times, weekdays, and connections', () => {
    const plan = parseAssistantPlan(
      [
        'cadence: weekdays',
        'times: 08:30, 18:00',
        'weekdays: mon,tue,wed,thu,fri',
        'connections: Slack, Gmail'
      ].join('\n')
    )
    expect(plan?.schedule).toEqual({
      cadence: 'weekdays',
      times: ['08:30', '18:00']
    })
    expect(plan?.connections).toEqual([{ name: 'Slack' }, { name: 'Gmail' }])
  })

  it('reads a free-text schedule line and ignores a weekday phrase it cannot parse', () => {
    const plan = parseAssistantPlan(
      ['schedule: every day at 8:05am', 'days: Monday to Friday'].join('\n')
    )
    // "Monday to Friday" is a phrase, not a weekday name, so it contributes no
    // weekday set and must not turn the daily cadence into a weekly one.
    expect(plan?.schedule?.cadence).toBe('daily')
    expect(plan?.schedule?.times).toEqual(['08:05'])
  })

  it('treats a mon-fri weekday set with no cadence as weekdays', () => {
    const plan = parseAssistantPlan(['times: 09:00', 'weekdays: mon,tue,wed,thu,fri'].join('\n'))
    expect(plan?.schedule).toEqual({
      cadence: 'weekdays',
      times: ['09:00']
    })
  })

  it('accepts full weekday names', () => {
    const plan = parseAssistantPlan(
      ['times: 09:00', 'weekdays: monday,tuesday,wednesday,thursday,friday'].join('\n')
    )
    expect(plan?.schedule).toEqual({ cadence: 'weekdays', times: ['09:00'] })
  })

  it('ignores unknown keys and returns null when nothing is usable', () => {
    expect(parseAssistantPlan('notes: the user prefers short reports')).toBeNull()
    expect(parseAssistantPlan('')).toBeNull()
  })

  it('extracts a tagged fence and a bare fence with a marker line', () => {
    const tagged = ['```assistant', 'cadence: daily', 'times: 08:30', '```'].join('\n')
    expect(extractAssistantPlanDraft(tagged)?.schedule).toEqual({
      cadence: 'daily',
      times: ['08:30']
    })
    const bare = ['```', 'assistant: Slack digest', 'cadence: hourly', '```'].join('\n')
    expect(extractAssistantPlanDraft(bare)?.schedule).toEqual({ cadence: 'hourly', times: [] })
    expect(extractAssistantPlanDraft('```knowledge\nGOAL\n```')).toBeNull()
  })

  it('takes the newest plan across messages', () => {
    const texts = [
      '```assistant\ncadence: daily\ntimes: 08:30\n```',
      '```assistant\ncadence: weekly\ntimes: 17:00\nweekdays: mon,fri\n```'
    ]
    expect(latestAssistantPlanDraft(texts)?.schedule).toEqual({
      cadence: 'weekly',
      times: ['17:00'],
      weekdays: [1, 5]
    })
  })
})

describe('assistant plan schema', () => {
  it('validates a schedule and connections from JSON', () => {
    const plan = parseAssistantPlanJson(
      JSON.stringify({
        schedule: { cadence: 'weekdays', times: ['08:30', '18:00'] },
        connections: [{ name: 'Slack' }, { name: 'Gmail', utilityId: 'gmail-mcp' }]
      })
    )
    expect(plan?.schedule).toEqual({ cadence: 'weekdays', times: ['08:30', '18:00'] })
    expect(plan?.connections).toEqual([
      { name: 'Slack' },
      { name: 'Gmail', utilityId: 'gmail-mcp' }
    ])
  })

  it('carries a connection setup prompt through the plan schema', () => {
    const plan = parseAssistantPlanJson(
      JSON.stringify({
        schedule: { cadence: 'daily', times: ['08:30'] },
        connections: [
          {
            name: 'Slack',
            setup:
              'Install the official Slack MCP at https://mcp.slack.com/mcp and collect the bot token.'
          }
        ]
      })
    )
    expect(plan?.connections).toEqual([
      {
        name: 'Slack',
        setup:
          'Install the official Slack MCP at https://mcp.slack.com/mcp and collect the bot token.'
      }
    ])
  })

  it('normalises and sorts times, and accepts a plain-string connection', () => {
    const plan = parseAssistantPlanValue({
      schedule: { cadence: 'daily', times: ['18:00', '8:30', '8:30'] },
      connections: ['Slack', { name: '  ' }, { name: 'Gmail' }]
    })
    expect(plan?.schedule).toEqual({ cadence: 'daily', times: ['08:30', '18:00'] })
    expect(plan?.connections).toEqual([{ name: 'Slack' }, { name: 'Gmail' }])
  })

  it('rejects a schedule the scheduler could never fire', () => {
    expect(parseAssistantPlanValue({ schedule: { cadence: 'daily', times: [] } })).toBeNull()
    expect(parseAssistantPlanValue({ schedule: { cadence: 'once' } })).toBeNull()
    expect(
      parseAssistantPlanValue({ schedule: { cadence: 'nonsense', times: ['09:00'] } })
    ).toBeNull()
  })

  it('keeps a one-shot schedule with its fire time', () => {
    expect(
      parseAssistantPlanValue({ schedule: { cadence: 'once', onceAt: 1_700_000_000_000 } })
    ).toEqual({
      schedule: { cadence: 'once', times: [], onceAt: 1_700_000_000_000 },
      connections: [],
      delivery: null,
      priority: null
    })
  })

  it('ignores JSON that is not a plan and a non-JSON body', () => {
    expect(parseAssistantPlanJson('notes: nothing here')).toBeNull()
    expect(parseAssistantPlanJson('{ not json')).toBeNull()
    expect(parseAssistantPlanValue({ connections: [] })).toBeNull()
  })

  it('reads a JSON plan inside the assistant fence, ahead of the text fallback', () => {
    const message = [
      '```assistant',
      '{"schedule":{"cadence":"hourly"},"connections":[{"name":"Slack"}]}',
      '```'
    ].join('\n')
    const plan = extractAssistantPlanDraft(message)
    expect(plan?.schedule).toEqual({ cadence: 'hourly', times: [] })
    expect(plan?.connections).toEqual([{ name: 'Slack' }])
  })

  it('describes the plan contract for the authoring prompt', () => {
    const schema = ASSISTANT_PLAN_JSON_SCHEMA as {
      required: string[]
      properties: Record<string, unknown>
    }
    expect(schema.required).toEqual(['schedule', 'connections'])
    expect(Object.keys(schema.properties)).toEqual([
      'schedule',
      'connections',
      'delivery',
      'priority'
    ])
  })
})

describe('assistant confirmation', () => {
  it('accepts a plain go-ahead and nothing more', () => {
    expect(isAssistantConfirmation('yes')).toBe(true)
    expect(isAssistantConfirmation('Yes!')).toBe(true)
    expect(isAssistantConfirmation('  go ahead  ')).toBe(true)
    expect(isAssistantConfirmation('looks good.')).toBe(true)
    expect(isAssistantConfirmation('👍')).toBe(true)
  })

  it('never reads a message that carries an instruction as a confirmation', () => {
    expect(isAssistantConfirmation('yes, but change the time to 9am')).toBe(false)
    expect(isAssistantConfirmation('no, make it weekly')).toBe(false)
    expect(isAssistantConfirmation('')).toBe(false)
    expect(
      isAssistantConfirmation('yes and also please add a section about retries to the knowledge')
    ).toBe(false)
  })
})

function mcpUtility(
  overrides: Partial<UtilityDefinitionFor<'mcp'>> = {}
): UtilityDefinitionFor<'mcp'> {
  return {
    id: 'slack-mcp',
    kind: 'mcp',
    name: 'Slack MCP',
    description: '',
    enabled: true,
    activation: 'on_demand',
    scope: { level: 'global' },
    config: { transport: 'stdio', command: 'npx', args: [] },
    credentials: [],
    harnessBindings: [],
    appOwned: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function catalog(utilities: UtilityDefinitionFor<'mcp'>[]): UtilityCatalog {
  return { utilities, secureStorageAvailable: true }
}

function connection(overrides: Partial<AssistantConnection> = {}): AssistantConnection {
  return { utilityId: 'slack-mcp', label: 'Slack MCP', ...overrides }
}

describe('assistant connections', () => {
  it('reports a linked, enabled, configured utility as ready', () => {
    const views = resolveConnections([connection()], catalog([mcpUtility()]))
    expect(views[0]?.status).toBe('ready')
    expect(views[0]?.detail).toBe('Ready')
  })

  it('reports a connection the library does not carry as needing setup', () => {
    const views = resolveConnections(
      [connection({ utilityId: 'required:slack', label: 'Slack', required: true })],
      catalog([])
    )
    expect(views[0]?.status).toBe('needs-setup')
    expect(views[0]?.detail).toBe('Not in your utility library yet')
  })

  it('links a required connection to a utility by name', () => {
    const views = resolveConnections(
      [connection({ utilityId: 'required:slack', label: 'Slack', required: true })],
      catalog([mcpUtility()])
    )
    expect(views[0]?.utility?.id).toBe('slack-mcp')
    expect(views[0]?.status).toBe('ready')
  })

  it('reports a switched-off utility as disabled', () => {
    const views = resolveConnections([connection()], catalog([mcpUtility({ enabled: false })]))
    expect(views[0]?.status).toBe('disabled')
  })

  it('reports a half-configured utility as incomplete', () => {
    const views = resolveConnections(
      [connection()],
      catalog([mcpUtility({ config: { transport: 'stdio' } })])
    )
    expect(views[0]?.status).toBe('incomplete')
    expect(views[0]?.detail).toBe('No server command or URL')
  })

  it('reports an MCP whose declared secret was never supplied as incomplete', () => {
    const views = resolveConnections(
      [connection()],
      catalog([
        mcpUtility({
          config: {
            transport: 'stdio',
            command: 'npx',
            environment: { SLACK_MCP_XOXP_TOKEN: '{env:SLACK_MCP_XOXP_TOKEN}' }
          }
        })
      ])
    )
    expect(views[0]?.status).toBe('incomplete')
    expect(views[0]?.detail).toBe('Needs SLACK_MCP_XOXP_TOKEN')
  })

  it('links a plan name to a library utility and keeps an unknown name required', () => {
    const merged = connectionsFromPlan(['Slack', 'Gmail'], [], [mcpUtility()])
    expect(merged).toEqual([
      { utilityId: 'slack-mcp', label: 'Slack MCP', kind: 'mcp' },
      { utilityId: 'required:gmail', label: 'Gmail', required: true }
    ])
  })

  it("prefers a plan connection's explicit utility id over name matching", () => {
    const merged = connectionsFromPlan(
      [{ name: 'Team chat', utilityId: 'slack-mcp' }],
      [],
      [mcpUtility()]
    )
    expect(merged).toEqual([{ utilityId: 'slack-mcp', label: 'Slack MCP', kind: 'mcp' }])
  })

  it('never duplicates a connection a plan names twice', () => {
    const merged = connectionsFromPlan(
      ['Slack', 'Slack MCP'],
      [{ utilityId: 'slack-mcp', label: 'Slack MCP', kind: 'mcp' }],
      [mcpUtility()]
    )
    expect(merged).toHaveLength(1)
  })

  it('carries the agent setup prompt onto a required connection', () => {
    const merged = connectionsFromPlan(
      [{ name: 'Slack', setup: 'Install the official Slack MCP from mcp.slack.com.' }],
      [],
      []
    )
    expect(merged).toEqual([
      {
        utilityId: 'required:slack',
        label: 'Slack',
        required: true,
        setup: 'Install the official Slack MCP from mcp.slack.com.'
      }
    ])
  })

  it('keeps the newest setup prompt when a later plan refines it', () => {
    const merged = connectionsFromPlan(
      [{ name: 'Slack', setup: 'Use the bot token, not the user token.' }],
      [
        {
          utilityId: 'required:slack',
          label: 'Slack',
          required: true,
          setup: 'Install Slack.'
        }
      ],
      []
    )
    expect(merged).toEqual([
      {
        utilityId: 'required:slack',
        label: 'Slack',
        required: true,
        setup: 'Use the bot token, not the user token.'
      }
    ])
  })

  it('leaves an existing setup prompt alone when a later plan omits it', () => {
    const merged = connectionsFromPlan(
      ['Slack'],
      [
        {
          utilityId: 'required:slack',
          label: 'Slack',
          required: true,
          setup: 'Install Slack.'
        }
      ],
      []
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]?.setup).toBe('Install Slack.')
  })
})

describe('assistant readiness', () => {
  it('names every gap an assistant still has', () => {
    expect(assistantGap({ knowledge: '', agents: undefined })).toBe('Needs a knowledge and a model')
    expect(assistantGap({ knowledge: 'Do it.', agents: undefined })).toBe('Needs a model')
    expect(
      assistantGap({
        knowledge: '',
        agents: { primary: { harnessId: 'h', providerId: 'p', modelId: 'm' }, fallbacks: [] }
      })
    ).toBe('Needs a knowledge')
  })

  it('reports an assistant with a knowledge and a primary model as ready', () => {
    expect(
      assistantGap({
        knowledge: 'Do it.',
        agents: { primary: { harnessId: 'h', providerId: 'p', modelId: 'm' }, fallbacks: [] }
      })
    ).toBeNull()
  })
})

describe('hand-off summary', () => {
  it('carries the assistant name and knowledge into the fork seed', () => {
    const summary = handoffSummary(
      { title: 'Slack drain', lastRunAt: 1_700_000_000_000 },
      { name: 'Slack checkup drain', knowledge: 'GOAL\nSweep Slack.' }
    )
    expect(summary).toContain('Task: Slack drain')
    expect(summary).toContain('Assistant: Slack checkup drain')
    expect(summary).toContain('How-to:\nGOAL\nSweep Slack.')
    expect(summary).toContain('Last scheduled run:')
  })

  it('omits the assistant and run lines for an assistant-less task with no run', () => {
    const summary = handoffSummary({ title: 'Ad hoc task' }, null)
    expect(summary).toContain('Task: Ad hoc task')
    expect(summary).not.toContain('Assistant:')
    expect(summary).not.toContain('Last scheduled run:')
  })
})
