import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const { handlers, showOpenDialog, showSaveDialog } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getName: vi.fn(() => 'CodeInOven'),
    getVersion: vi.fn(() => '0.1.0')
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
    getFocusedWindow: vi.fn(() => null)
  },
  dialog: {
    showOpenDialog,
    showSaveDialog
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

import type {
  AppConfig,
  BrainstormContent,
  BrainstormDocument,
  EngineeringSpec,
  EngineeringSpecContent
} from '../lib/types'
import { ProjectManager } from '../lib/engines/project-manager'
import { exportEngineeringSpecMarkdown } from '../lib/spec/spec-markdown'
import { StorageEngine } from './storage-engine'
import { registerIpcHandlers, validateAppConfigPatch } from './ipc-handlers'
import { createTestDb, destroyTestDb } from './database/test-helper'
import type { Database } from './database/database'
import { ProjectRepo } from './database/repositories/project-repo'
import { ThreadRepo } from './database/repositories/thread-repo'

let database: Database

const defaultConfig: AppConfig = {
  theme: 'system',
  threadLimit: 70,
  questionTimeoutMs: 300_000,
  keybindings: {},
  slashCommandMode: 'app',
  preferredEditor: 'system',
  memory: { enabled: true, entries: [] },
  agentDefaults: { syncFromThreadChanges: false },
  autoDownloadUpdates: true,
  autoInstallUpdates: true,
  updateChannel: 'stable'
}

beforeEach(async () => {
  handlers.clear()
  vi.restoreAllMocks()
  showOpenDialog.mockReset()
  showSaveDialog.mockReset()
  database = await createTestDb()
})

afterEach(() => destroyTestDb(database))

describe('validateAppConfigPatch', () => {
  it('accepts every renderer-editable config field', () => {
    const memory = {
      enabled: true,
      entries: [
        {
          id: 'style',
          label: 'Style',
          content: 'Prefer small contextual commits.',
          enabled: true,
          updatedAt: 1
        }
      ]
    }

    expect(
      validateAppConfigPatch({
        theme: 'dark',
        threadLimit: 120,
        slashCommandMode: 'passthrough',
        preferredEditor: 'ghostty',
        agentDefaults: {
          syncFromThreadChanges: true,
          seniorEngineer: {
            harnessId: 'opencode',
            providerId: 'openai',
            modelId: 'gpt-5.6'
          }
        },
        memory
      })
    ).toMatchObject({
      theme: 'dark',
      threadLimit: 120,
      slashCommandMode: 'passthrough',
      preferredEditor: 'ghostty',
      agentDefaults: {
        syncFromThreadChanges: true,
        seniorEngineer: {
          harnessId: 'opencode',
          providerId: 'openai',
          modelId: 'gpt-5.6'
        }
      },
      memory: {
        enabled: true,
        entries: [
          expect.objectContaining({
            ...memory.entries[0],
            category: 'preference',
            frequency: 1,
            lastReinforced: expect.any(Number),
            priority: 'medium',
            scope: 'global',
            source: 'manual'
          })
        ]
      }
    })
  })

  it.each([
    null,
    [],
    { keybindings: {} },
    { lastFolderDialogPath: '/tmp' },
    { theme: 'sepia' },
    { threadLimit: 0 },
    { threadLimit: 1.5 },
    { threadLimit: 1001 },
    { slashCommandMode: 'both' },
    { preferredEditor: 'unknown-editor' },
    { agentDefaults: { syncFromThreadChanges: 'yes' } },
    {
      memory: {
        enabled: true,
        entries: [
          {
            id: 'secret',
            label: 'Secret',
            content: 'api_key=super-secret-value',
            enabled: true,
            updatedAt: 1
          }
        ]
      }
    }
  ])('rejects invalid or internal config patches: %j', (patch) => {
    expect(() => validateAppConfigPatch(patch)).toThrow(TypeError)
  })
})

describe('config IPC', () => {
  it('reads and persists validated config patches without dropping internal fields', async () => {
    const storage = new StorageEngine()
    const getConfig = vi.spyOn(storage, 'getConfig').mockResolvedValue({
      ...defaultConfig,
      lastFolderDialogPath: '/projects'
    })
    const saveConfig = vi.spyOn(storage, 'saveConfig').mockResolvedValue()

    registerIpcHandlers(storage, database)

    const getHandler = handlers.get('config:get')
    const updateHandler = handlers.get('config:update')
    const syncAgentRoleHandler = handlers.get('config:syncAgentRole')
    expect(getHandler).toBeDefined()
    expect(updateHandler).toBeDefined()
    expect(syncAgentRoleHandler).toBeDefined()

    await expect(getHandler?.({})).resolves.toEqual({
      ...defaultConfig,
      lastFolderDialogPath: '/projects'
    })
    await expect(
      updateHandler?.({}, { theme: 'dark', slashCommandMode: 'passthrough' })
    ).resolves.toEqual({
      ...defaultConfig,
      theme: 'dark',
      slashCommandMode: 'passthrough',
      lastFolderDialogPath: '/projects'
    })

    expect(getConfig).toHaveBeenCalled()
    expect(saveConfig).toHaveBeenCalledWith({
      ...defaultConfig,
      theme: 'dark',
      slashCommandMode: 'passthrough',
      lastFolderDialogPath: '/projects'
    })

    getConfig.mockResolvedValue({
      ...defaultConfig,
      agentDefaults: { syncFromThreadChanges: true }
    })
    await expect(
      syncAgentRoleHandler?.({}, 'worker', {
        harnessId: 'opencode',
        providerId: 'openai',
        modelId: 'gpt-5.6'
      })
    ).resolves.toMatchObject({
      agentDefaults: {
        syncFromThreadChanges: true,
        worker: { harnessId: 'opencode', providerId: 'openai', modelId: 'gpt-5.6' }
      }
    })
    expect(saveConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agentDefaults: {
          syncFromThreadChanges: true,
          worker: { harnessId: 'opencode', providerId: 'openai', modelId: 'gpt-5.6' }
        }
      })
    )
  })

  it('rejects invalid patches before storage is written', async () => {
    const storage = new StorageEngine()
    vi.spyOn(storage, 'getConfig').mockResolvedValue(defaultConfig)
    const saveConfig = vi.spyOn(storage, 'saveConfig').mockResolvedValue()

    registerIpcHandlers(storage, database)

    const updateHandler = handlers.get('config:update')
    await expect(updateHandler?.({}, { keybindings: { quit: 'cmd+q' } })).rejects.toThrow(
      'Unsupported config field'
    )
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('uses the configured thread limit as the default for new projects', async () => {
    const storage = new StorageEngine()
    vi.spyOn(storage, 'getConfig').mockResolvedValue({ ...defaultConfig, threadLimit: 150 })
    const createProject = vi.spyOn(ProjectManager.prototype, 'createProject').mockResolvedValue({
      id: 'project-1',
      name: 'CodeInOven',
      path: '/projects/codeinoven',
      source: 'local',
      providerId: 'opencode',
      workflowId: 'default',
      threadLimit: 150,
      createdAt: 1,
      updatedAt: 1
    })

    registerIpcHandlers(storage, database)

    const createHandler = handlers.get('project:create')
    await createHandler?.({}, { name: 'CodeInOven', path: '/projects/codeinoven' })

    expect(createProject).toHaveBeenCalledWith({
      name: 'CodeInOven',
      path: '/projects/codeinoven',
      threadLimit: 150
    })
  })
})

const validSpecContent: EngineeringSpecContent = {
  problem: 'Changes are not coordinated.',
  resolutionSummary: 'Introduce a reviewed specification workflow.',
  phases: [
    {
      id: 'phase-1',
      title: 'Specification',
      objective: 'Produce an approved specification.',
      checkpoints: [
        {
          id: 'checkpoint-1',
          description: 'Review the specification.',
          evidence: 'Approval is persisted.'
        }
      ],
      fileOperations: [
        {
          path: 'src/spec.ts',
          operation: 'create',
          reason: 'Add the specification workflow.'
        }
      ],
      commit: 'feat(spec): add specification workflow'
    }
  ],
  successCriteria: ['The approved version is immutable.'],
  testStrategy: 'Run focused unit tests.',
  documentationRequirements: ['Document import and export.'],
  additionalInfo: 'Preserve reviewer recommendations and existing project findings.',
  commitPattern: 'feat(spec): <scope>',
  constraints: ['Do not accept renderer-selected filesystem paths.'],
  risks: ['Malformed Markdown imports.']
}

function seedSpecThread(projectPath: string): void {
  const now = Date.now()
  new ProjectRepo(database).upsert({
    id: 'project-1',
    name: 'Specification project',
    path: projectPath,
    source: 'local',
    providerId: 'openai',
    workflowId: 'default',
    threadLimit: 70,
    changeTrackingMode: 'manual',
    createdAt: now,
    updatedAt: now
  })
  new ThreadRepo(database).upsert({
    id: 'thread-1',
    projectId: 'project-1',
    providerId: 'openai',
    title: 'Specification workflow',
    titleSource: 'manual',
    status: 'created',
    pinned: false,
    archived: false,
    read: false,
    createdAt: now,
    updatedAt: Date.now(),
    lastActivity: now,
    workingDirectory: projectPath
  })
}

const validBrainstormContent: BrainstormContent = {
  title: 'Choose direction',
  summary: 'Resolve the product direction before specification.',
  sections: [
    { id: 'context', title: 'Context', markdown: 'The request is still broad.' },
    { id: 'goals', title: 'Goals', markdown: '- Agree on scope' },
    { id: 'decisions', title: 'Decisions', markdown: '- Use a durable workflow' },
    { id: 'open_questions', title: 'Open Questions', markdown: '- Which audience?' },
    { id: 'constraints', title: 'Constraints', markdown: '- No automatic choice' },
    { id: 'proposed_direction', title: 'Proposed Direction', markdown: 'Review before spec.' }
  ]
}

describe('brainstorm IPC', () => {
  it('persists entry choice and exposes the versioned document boundary', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'codeinoven-brainstorm-ipc-'))
    const storage = new StorageEngine(storageRoot)
    await storage.initialize()
    seedSpecThread(storageRoot)
    registerIpcHandlers(storage, database)

    expect(handlers.get('brainstorm:ensureWorkflow')?.({}, 'project-1', 'thread-1')).toMatchObject({
      stage: 'choice_pending'
    })
    expect(
      handlers.get('brainstorm:chooseEntry')?.({}, 'project-1', 'thread-1', 'brainstorm')
    ).toMatchObject({ entryChoice: 'brainstorm', stage: 'drafting' })
    const draft = (await handlers.get('brainstorm:createDraft')?.(
      {},
      'project-1',
      'thread-1',
      validBrainstormContent,
      { source: 'agent', actor: 'Sr. Engineer' }
    )) as BrainstormDocument
    await expect(
      handlers.get('brainstorm:getActive')?.({}, 'project-1', 'thread-1')
    ).resolves.toEqual(draft)
    expect(
      handlers.get('brainstorm:listVersions')?.({}, 'project-1', 'thread-1', draft.id)
    ).toEqual([draft])
    expect(() =>
      handlers.get('brainstorm:chooseEntry')?.({}, 'project-1', 'thread-1', 'invalid')
    ).toThrow('brainstorm or spec')
  })
})

describe('specification IPC', () => {
  it('registers typed workflow handlers and rejects unsafe boundary values', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'codeinoven-spec-ipc-'))
    const storage = new StorageEngine(storageRoot)
    await storage.initialize()
    seedSpecThread(storageRoot)
    registerIpcHandlers(storage, database)

    const createDraft = handlers.get('spec:createDraft')
    const getActive = handlers.get('spec:getActive')
    const listVersions = handlers.get('spec:listVersions')
    const created = (await createDraft?.({}, 'project-1', 'thread-1', validSpecContent, {
      source: 'manual',
      actor: 'tester'
    })) as EngineeringSpec

    expect(created.status).toBe('draft')
    await expect(getActive?.({}, 'project-1', 'thread-1')).resolves.toEqual(created)
    await expect(listVersions?.({}, 'project-1', 'thread-1', created.id)).resolves.toEqual([
      created
    ])
    expect(() =>
      createDraft?.({}, '../escape', 'thread-1', validSpecContent, {
        source: 'manual',
        actor: 'tester'
      })
    ).toThrow('Project ID')
    expect(() =>
      createDraft?.(
        {},
        'project-1',
        'thread-1',
        { ...validSpecContent, phases: 'bad' },
        {
          source: 'manual',
          actor: 'tester'
        }
      )
    ).toThrow('phases')
  })

  it('imports and exports Markdown only through native dialogs', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'codeinoven-spec-ipc-'))
    const storage = new StorageEngine(storageRoot)
    await storage.initialize()
    seedSpecThread(storageRoot)
    const importPath = join(storageRoot, 'import.md')
    const exportPath = join(storageRoot, 'export.md')
    const sourceSpec: EngineeringSpec = {
      schemaVersion: 1,
      id: 'source-spec',
      projectId: 'project-1',
      threadId: 'thread-1',
      version: 1,
      status: 'draft',
      content: validSpecContent,
      annotations: [],
      decisionComments: [],
      context: [],
      provenance: { source: 'manual', actor: 'tester', createdAt: 1 },
      createdAt: 1,
      updatedAt: 1
    }
    await writeFile(importPath, exportEngineeringSpecMarkdown(sourceSpec), 'utf-8')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [importPath] })
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: exportPath })
    registerIpcHandlers(storage, database)

    const imported = (await handlers.get('spec:importMarkdown')?.(
      {},
      'project-1',
      'thread-1'
    )) as EngineeringSpec
    expect(imported.provenance).toMatchObject({
      source: 'markdown_import',
      importedFilename: 'import.md'
    })
    await expect(handlers.get('spec:exportMarkdown')?.({}, imported)).resolves.toBe(exportPath)
    await expect(readFile(exportPath, 'utf-8')).resolves.toContain('## Success Criteria')
    expect(showOpenDialog).toHaveBeenCalledOnce()
    expect(showSaveDialog).toHaveBeenCalledOnce()
  })
})
