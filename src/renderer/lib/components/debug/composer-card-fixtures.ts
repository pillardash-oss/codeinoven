/**
 * Sample state for the composer card gallery (developer tool).
 *
 * Every fixture here exists so the gallery can render one card and one state
 * without a live run behind it. The values are written to look like the real
 * thing a user sees, never to be pretty: the point of the gallery is to review
 * the card's own design, so the copy, counts and paths are the ones the app
 * would really put on screen.
 */
import type {
  AgentPart,
  AssignmentPlan,
  AuditReport,
  ImageDescriptorErrorRequest,
  PermissionRequest,
  PendingAgentQuestionRequest,
  ProviderCatalog,
  TurnCheckpointSummary
} from '$shared/types'
import type { ActionDefinition, ActionSource } from '$lib/actions'
import type { AgentTodoItem } from '$shared/agent-todos'
import { APP_NAME } from '$shared/brand'
import type { ExpertSummary } from '$shared/experts'
import { DEFAULT_HARNESS } from '$shared/harness-default'
import type { ThreadExpertState } from '$shared/ipc-contract'
import type { SpeechScope } from '$shared/speech/types'
import type { StartAfterThreadReference } from '$lib/stores/renderer-recovery'
import type { ComposerMentionEntry } from './../chats/composer-mentions'

const NOW = Date.now()

export const galleryScope: SpeechScope = { kind: 'global' }

/** The source every one of the app's own slash actions is filed under. */
const applicationActionSource = {
  id: 'application',
  label: APP_NAME,
  kind: 'app'
} satisfies ActionSource

/** A permission the agent wants and the user has to answer. */
export const galleryPermission: PermissionRequest = {
  id: 'gallery-permission',
  sessionId: 'gallery-session',
  permission: 'bash',
  patterns: ['git push origin main', 'git push --force-with-lease origin main'],
  metadata: { command: 'git push origin main', cwd: '/work/codeinoven' },
  policy: {
    risk: 'high',
    reason: 'Pushing to a protected branch publishes work to everyone on the repository.',
    scopedPaths: ['/work/codeinoven'],
    expiresAt: NOW + 45_000
  }
}

function question(
  overrides: Partial<PendingAgentQuestionRequest['questions'][number]>
): PendingAgentQuestionRequest['questions'][number] {
  return { prompt: 'Which branch should this work land on?', ...overrides }
}

/** One question, rich options, a recommendation, and a live countdown. */
export const galleryQuestionSingle: PendingAgentQuestionRequest = {
  requestId: 'gallery-question-single',
  sessionId: 'gallery-session',
  projectId: 'gallery-project',
  threadId: 'gallery-thread',
  createdAt: NOW,
  activeQuestionIndex: 0,
  answers: [[]],
  interactedQuestionIndexes: [],
  expiresAt: NOW + 134_000,
  questions: [
    question({
      header: 'Question from the agent',
      prompt: 'Two branches could take this change. Which one should it land on?',
      description: 'The open pull request is on `release/2.4`; `main` is two commits ahead of it.',
      richOptions: [
        {
          label: 'Use the existing branch',
          description: 'Keeps the open pull request and its review history.',
          recommended: true
        },
        {
          label: 'Create a new branch',
          description: 'Starts clean from main; the open pull request is left alone.'
        },
        {
          label: 'Patch the release branch directly',
          description: 'Fastest, but it bypasses review and will need a follow-up.',
          instruction: 'git switch release/2.4 && git cherry-pick <sha> && git push'
        }
      ]
    })
  ]
}

/** A multi-select question, answered over two questions. */
export const galleryQuestionMultiple: PendingAgentQuestionRequest = {
  ...galleryQuestionSingle,
  requestId: 'gallery-question-multiple',
  questions: [
    question({
      header: 'Question from the agent',
      prompt: 'Which checks should run before this lands?',
      multiple: true,
      custom: false,
      richOptions: [
        { label: 'Unit tests', description: 'The repository test script.', recommended: true },
        { label: 'Type check', description: 'svelte-check over the renderer.' },
        { label: 'Bundle budget', description: 'The 3 MiB raw and 900 KiB gzip budgets.' }
      ]
    })
  ]
}

/** Plain options, no descriptions: the compact shape of the same card. */
export const galleryQuestionPlain: PendingAgentQuestionRequest = {
  ...galleryQuestionSingle,
  requestId: 'gallery-question-plain',
  questions: [
    question({
      header: 'Question from the agent',
      prompt: 'Should I keep the draft you opened yesterday?',
      options: ['Keep it', 'Discard it', 'Keep it, but not the images']
    })
  ]
}

/** A file request: the options are paths and the card takes a drop. */
export const galleryQuestionFile: PendingAgentQuestionRequest = {
  ...galleryQuestionSingle,
  requestId: 'gallery-question-file',
  questions: [
    question({
      header: 'Question from the agent',
      prompt: 'Which screenshot should the review use?',
      fileRequest: true,
      custom: true,
      richOptions: [
        { label: '/Users/dev/Pictures/first-run.png', description: 'The window as it opens.' },
        { label: '/Users/dev/Pictures/empty-state.png', description: 'The empty conversation.' }
      ]
    })
  ]
}

/** The three questions of a release-planning walkthrough, shared by the two
 *  stepper states so they cannot drift apart. */
const planningWalkthroughQuestions = [
  question({
    header: 'Plan the release',
    prompt: 'Two branches could take this change. Which one should it land on?',
    options: ['Use the existing branch', 'Create a new branch']
  }),
  question({
    header: 'Plan the release',
    prompt: 'How should the release notes be written?',
    richOptions: [
      { label: 'From the commits', description: 'Grouped by area.', recommended: true },
      { label: 'From the specification', description: 'Written for the reader.' }
    ]
  }),
  question({
    header: 'Plan the release',
    prompt: 'Who reviews it before it ships?',
    options: ['The Reviewer sub-agent', 'I will', 'Nobody']
  })
]

/** A three-question walkthrough, part answered: the stepper in the middle. */
export const galleryQuestionWalkthrough: PendingAgentQuestionRequest = {
  ...galleryQuestionSingle,
  requestId: 'gallery-question-walkthrough',
  activeQuestionIndex: 1,
  answers: [['Use the existing branch'], []],
  interactedQuestionIndexes: [0],
  expiresAt: undefined,
  questions: planningWalkthroughQuestions
}

/**
 * The same walkthrough with every question answered, read from the middle. This
 * is the state that used to hide the forward arrow: the card auto-advances as
 * options are picked, so it arrives at the last question with nothing left to
 * answer, and a step back used to leave no way forward.
 */
export const galleryQuestionAnswered: PendingAgentQuestionRequest = {
  ...galleryQuestionWalkthrough,
  requestId: 'gallery-question-answered',
  answers: [['Use the existing branch'], ['From the commits'], ['I will']],
  interactedQuestionIndexes: [0, 1, 2]
}

/** A secret request with two entries. Secrets always run their countdown: the
 *  app deadlines a secret card like any other question, so the card here carries
 *  a live one. */
export const gallerySecret: PendingAgentQuestionRequest = {
  ...galleryQuestionSingle,
  requestId: 'gallery-secret',
  questions: [
    question({
      header: 'Secret the agent needs',
      prompt: 'The deploy step needs a token for the registry.',
      secretRequest: true,
      secretId: 'secret-token',
      secretEnvironmentVariable: 'REGISTRY_TOKEN'
    }),
    question({
      header: 'Secret the agent needs',
      prompt: 'The smoke test signs in with a staging password.',
      secretRequest: true,
      secretId: 'secret-password',
      secretEnvironmentVariable: 'STAGING_PASSWORD'
    })
  ]
}

/** The same secret request while the user is filling a value in: the countdown
 *  is held (the card the user is typing into is never cut off), which is the
 *  paused reading, never a card without a deadline. */
export const gallerySecretPaused: PendingAgentQuestionRequest = {
  ...gallerySecret,
  requestId: 'gallery-secret-paused',
  expiresAt: undefined,
  interactedQuestionIndexes: [0]
}

/** A finished audit with one open annotation: the report carried on the card. */
export const galleryAuditReport: AuditReport = {
  schemaVersion: 1,
  id: 'gallery-audit',
  projectId: 'gallery-project',
  threadId: 'gallery-thread',
  version: 2,
  outcome: 'rework_required',
  evidenceValidation: 'partial',
  reworkCycle: 1,
  content: {
    executiveSummary: 'The implementation matches the specification apart from one missing guard.',
    findings: [
      {
        id: 'finding-1',
        severity: 'high',
        title: 'The retry path can double-send',
        description: 'A retry after a timeout sends the same message twice.',
        evidence: 'src/main/chat/chat-engine.ts'
      }
    ],
    resolutionRecommendation: 'Guard the send with the in-flight check before retrying.',
    conclusion: 'Ship it once the guard is in.'
  },
  annotations: [
    {
      id: 'annotation-1',
      section: 'findings',
      body: 'This is the same guard the queue already uses; reuse it.',
      status: 'open',
      author: 'you',
      createdAt: NOW
    }
  ],
  provenance: { source: 'agent', actor: 'Auditor', createdAt: NOW },
  createdAt: NOW - 600_000,
  updatedAt: NOW - 60_000
}

/** A signed-off-looking assignment draft with four workers. */
export const galleryAssignment: AssignmentPlan = {
  schemaVersion: 1,
  id: 'gallery-assignment',
  projectId: 'gallery-project',
  coordinatorThreadId: 'gallery-thread',
  version: 1,
  status: 'draft',
  content: {
    title: 'Composer card design pass',
    summary: 'Bring every composer card onto one design language and add the review gallery.',
    phases: [
      { id: 'phase-1', title: 'Primitives and cards', description: 'Shared cards and every card.' },
      {
        id: 'phase-2',
        title: 'Gallery and verification',
        description: 'Dev gallery, checks, commit.'
      }
    ],
    tasks: [
      {
        id: 'task-1',
        phaseId: 'phase-1',
        title: 'Shared card primitives',
        description: 'Head, foot, chip, button, option.',
        prompt: 'Build the shared composer card primitives.',
        owner: 'worker',
        dependsOn: [],
        expectedFiles: ['src/renderer/lib/components/shared/CardHead.svelte'],
        auditChecklist: ['Every card renders through the primitives.'],
        status: 'planned'
      },
      {
        id: 'task-2',
        phaseId: 'phase-1',
        title: 'Composer cards',
        description: 'Rewrite each card onto the language.',
        prompt: 'Rewrite every composer card.',
        owner: 'worker',
        dependsOn: ['task-1'],
        expectedFiles: ['src/renderer/lib/components/threads/AgentTodoCard.svelte'],
        auditChecklist: ['No rounded corners remain.'],
        status: 'planned'
      },
      {
        id: 'task-3',
        phaseId: 'phase-2',
        title: 'Trigger gallery',
        description: 'A button per card and per state.',
        prompt: 'Build the dev-only card gallery.',
        owner: 'worker',
        dependsOn: ['task-2'],
        expectedFiles: ['src/renderer/lib/components/debug/ComposerCardGallery.svelte'],
        auditChecklist: ['No card is missing from the gallery.'],
        status: 'planned'
      },
      {
        id: 'task-4',
        phaseId: 'phase-2',
        title: 'Verification',
        description: 'Check, lint, format, look at it.',
        prompt: 'Verify the pass.',
        owner: 'worker',
        dependsOn: ['task-3'],
        expectedFiles: ['docs/APP-BIBLE.md'],
        auditChecklist: ['Checks are clean.'],
        status: 'planned'
      }
    ]
  },
  provenance: { source: 'agent', actor: 'Sr. Engineer', createdAt: NOW },
  createdAt: NOW,
  updatedAt: NOW
}

/** A failed vision-descriptor call with a partial description. The requesting
 *  model is the text-only model whose turn is blocked, so the card keeps the
 *  "False positive" action it reports that model with. */
export const galleryImageDescriptorError: ImageDescriptorErrorRequest = {
  id: 'gallery-image-descriptor',
  sessionId: 'gallery-session',
  projectId: 'gallery-project',
  threadId: 'gallery-thread',
  surfaceThreadId: 'gallery-thread',
  error: 'The vision model rejected the request: image is larger than the 8 MiB limit.',
  kind: 'unknown',
  selection: {
    harnessId: 'opencode',
    providerId: 'opencode-go',
    modelId: 'deepseek-v4.1-flash'
  },
  requestingModel: {
    harnessId: DEFAULT_HARNESS,
    providerId: 'gallery-provider',
    modelId: 'gallery-text-model'
  },
  partialOutput: 'A window with a left rail and a conversation.',
  imageCount: 1,
  imageId: 'image-1',
  createdAt: NOW
}

/**
 * The two AI-account states.
 *
 * Nothing published means nothing connected: Pi and OpenCode publish only the
 * providers the user holds credentials for. The connected state carries a small
 * catalog of its own so the state does not depend on whichever accounts the
 * machine running the gallery happens to hold.
 */
export const galleryProvidersEmpty: ProviderCatalog[] = []

export const galleryProvidersConnected: ProviderCatalog[] = [
  {
    id: 'gallery-provider',
    name: 'Gallery provider',
    harnessId: DEFAULT_HARNESS,
    supportsAttachments: true,
    models: [
      {
        id: 'gallery-text-model',
        providerId: 'gallery-provider',
        name: 'Gallery text model',
        reasoning: true,
        attachment: false,
        toolcall: true
      },
      {
        id: 'gallery-vision-model',
        providerId: 'gallery-provider',
        name: 'Gallery vision model',
        reasoning: false,
        attachment: true,
        toolcall: true
      }
    ]
  }
]

/** The expert gate for a design session with two staffed experts. */
export const galleryExpertState: ThreadExpertState = {
  threadId: 'gallery-thread',
  decision: null,
  signature: 'gallery-signature',
  session: 'design',
  experts: [
    {
      id: 'art-director',
      label: 'Art direction',
      produces: 'image',
      craftLabel: 'Art director',
      craftWork: 'art direction',
      craftDescription: 'Sets the visual direction for a design.',
      mediaModel: 'black-forest-labs/flux-1.1-pro',
      instructions: 'Keep the workstation language.'
    },
    {
      id: 'copywriter',
      label: 'Interface copy',
      produces: 'text',
      craftLabel: 'Copywriter',
      craftWork: 'copywriting',
      craftDescription: 'Writes the words on screen.',
      selection: {
        harnessId: 'opencode',
        providerId: 'opencode-go',
        modelId: 'deepseek-v4.1-flash'
      },
      instructions: 'Short sentences, no jargon.'
    }
  ] satisfies ExpertSummary[]
}

/** A six-item task list: two done, one in progress, three still pending. */
export const galleryTodoItems: AgentTodoItem[] = [
  { id: 'todo-1', label: 'Read the current schema', status: 'completed' },
  { id: 'todo-2', label: 'Write the migration', status: 'completed' },
  { id: 'todo-3', label: 'Update the repository layer', status: 'in_progress' },
  { id: 'todo-4', label: 'Add the regression check', status: 'pending' },
  { id: 'todo-5', label: 'Run the suite', status: 'pending' },
  { id: 'todo-6', label: 'Write the changelog entry', status: 'pending' }
]

/** A sub-agent part, live, with a model and an elapsed time the card can read. */
export const gallerySubagentPart: Extract<AgentPart, { type: 'subagent' }> = {
  type: 'subagent',
  id: 'gallery-subagent',
  messageID: 'gallery-message',
  activity: {
    status: 'running',
    agent: 'reviewer',
    description: 'Review the diff for regressions',
    providerId: 'opencode-go',
    modelId: 'deepseek-v4.1-flash',
    background: false,
    time: { start: NOW - 151_000 }
  }
}

/** A queued message and the dependencies that hold it. */
export const galleryStartAfterThreads: StartAfterThreadReference[] = [
  { id: 'thread-auth', title: 'Fix auth refresh' },
  { id: 'thread-fixtures', title: 'Seed the test fixtures' }
]

/** Two checkpoint summaries: a fresh edit and one that was undone. */
export const galleryCheckpoint: TurnCheckpointSummary = {
  id: 'gallery-checkpoint',
  projectId: 'gallery-project',
  threadId: 'gallery-thread',
  label: 'Composer card design pass',
  status: 'completed',
  changes: [
    {
      kind: 'modified',
      path: 'src/renderer/lib/components/threads/AgentTodoCard.svelte',
      binary: false,
      additions: 42,
      deletions: 18
    },
    {
      kind: 'created',
      path: 'src/renderer/lib/components/shared/CardHead.svelte',
      binary: false,
      additions: 61,
      deletions: 0
    },
    {
      kind: 'modified',
      path: 'src/renderer/lib/components/chats/ChatComposer.svelte',
      binary: false,
      additions: 9,
      deletions: 14
    },
    {
      kind: 'modified',
      path: 'src/renderer/lib/components/threads/RunChangesCard.svelte',
      binary: false,
      additions: 88,
      deletions: 41
    },
    {
      kind: 'modified',
      path: 'src/renderer/lib/components/threads/ThreadView.svelte',
      binary: false,
      additions: 120,
      deletions: 96
    }
  ],
  createdAt: NOW,
  completedAt: NOW
}

export const galleryCheckpointUndone: TurnCheckpointSummary = {
  ...galleryCheckpoint,
  id: 'gallery-checkpoint-undone',
  status: 'rolled_back',
  rolledBackAt: NOW,
  rolledBackPaths: galleryCheckpoint.changes.map((change) => change.path)
}

/** Mention-menu entries: two project files, one of them git-ignored. */
export const galleryMentionEntries: ComposerMentionEntry[] = [
  {
    type: 'project',
    entry: {
      path: 'src/renderer/lib/components/chats/ChatComposer.svelte',
      name: 'ChatComposer.svelte',
      kind: 'file',
      ignored: false
    }
  },
  {
    type: 'project',
    entry: {
      path: 'src/renderer/lib/components/shared/CardHead.svelte',
      name: 'CardHead.svelte',
      kind: 'file',
      ignored: true
    }
  }
] satisfies ComposerMentionEntry[]

/** Slash actions, one of them disabled, so the menu shows both states. */
export const gallerySlashActions: readonly ActionDefinition[] = [
  {
    id: 'command:compact',
    title: 'Compact conversation',
    description: 'Summarize older work to free context',
    category: 'command',
    source: applicationActionSource,
    keywords: ['summarize', 'context', 'tokens']
  },
  {
    id: 'selector:models',
    title: '/models',
    description: 'Open the full model selector and search',
    category: 'model',
    source: applicationActionSource,
    keywords: ['model', 'favorites', 'provider']
  },
  {
    id: 'mode:permission:full_access',
    title: 'Permissions: Full Access',
    description: 'Run in yolo mode: every operation auto-approved',
    category: 'mode',
    source: applicationActionSource,
    keywords: ['access', 'approval', 'security', 'yolo', 'unrestricted'],
    disabledReason: 'This thread already runs with full access.'
  }
]
