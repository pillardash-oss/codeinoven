import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { simpleGit } from 'simple-git'

const { handlers, listeners, showOpenDialog, showSaveDialog, safeStorage } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`, 'utf-8')),
    decryptString: vi.fn((buffer: Buffer) => buffer.toString('utf-8').replace(/^enc:/u, ''))
  }
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
  safeStorage,
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }),
    on: vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(channel, listener)
    })
  }
}))

import type {
  AppConfig,
  BrainstormContent,
  BrainstormDocument,
  CloudDeploymentConfig,
  CloudDeploymentContainer,
  CloudDeploymentDeployment,
  CloudDeploymentProviderAccount,
  EngineeringSpec,
  EngineeringSpecContent
} from '../../src/lib/types'
import { ProjectManager } from '../../src/lib/engines/project-manager'
import { exportEngineeringSpecMarkdown } from '../../src/lib/spec/spec-markdown'
import { StorageEngine } from '../../src/main/storage/storage-engine'
import { registerIpcHandlers, validateAppConfigPatch } from '../../src/main/ipc/ipc-handlers'
import { appRendererNavigationTargets } from '../../src/main/ipc/trusted-ipc-main'
import { createTestDb, destroyTestDb } from './database/test-helper'
import type { Database } from '../../src/main/database/database'
import { ProjectRepo } from '../../src/main/database/repositories/project-repo'
import { ThreadRepo } from '../../src/main/database/repositories/thread-repo'
import { DEFAULT_AGENT_BEHAVIOR_PROMPT } from '../../src/lib/agent-behavior'

let database: Database

/**
 * Every registered handler is wrapped by `trustedIpcMain`, which rejects a
 * sender frame that is not the app's own renderer document. Build an event
 * that mirrors `appRendererNavigationTargets()` so channel invocation is
 * accepted in tests.
 */
function trustedEvent(): { senderFrame: { url: string; parent: null } } {
  return {
    senderFrame: {
      url: appRendererNavigationTargets()[0],
      parent: null
    }
  }
}

const defaultConfig: AppConfig = {
  theme: 'system',
  onboardingCompleted: false,
  threadLimit: 70,
  questionTimeoutMs: 300_000,
  keybindings: {},
  slashCommandMode: 'app',
  preferredEditor: 'system',
  openLocalhostInCioBrowser: true,
  memory: { enabled: true, chatEnabled: true, entries: [] },
  agentDefaults: { syncFromThreadChanges: false },
  agentBehaviorPrompt: DEFAULT_AGENT_BEHAVIOR_PROMPT,
  autoDownloadUpdates: true,
  autoInstallUpdates: true,
  updateChannel: 'stable',
  keepAwakeWhileWorking: false,
  keepAwakeWhileRemoteConnected: true,
  imageDescriptorAskAgain: false,
  autoRetryAfterReset: false,
  resumeWorkOnRestart: true,
  defaultMergeMethod: 'squash',
  defaultPullStrategy: 'ask',
  maxDiffLines: 100
}

beforeEach(async () => {
  handlers.clear()
  listeners.clear()
  vi.restoreAllMocks()
  showOpenDialog.mockReset()
  showSaveDialog.mockReset()
  safeStorage.isEncryptionAvailable.mockReset()
  safeStorage.isEncryptionAvailable.mockReturnValue(true)
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
          },
          imageDescriptor: {
            harnessId: 'opencode',
            providerId: 'anthropic',
            modelId: 'claude-sonnet-4-5'
          }
        },
        imageDescriptorAskAgain: true,
        autoRetryAfterReset: true,
        resumeWorkOnRestart: false,
        defaultMergeMethod: 'rebase',
        maxDiffLines: 250,
        agentBehaviorPrompt: 'Custom agent behavior.',
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
        },
        imageDescriptor: {
          harnessId: 'opencode',
          providerId: 'anthropic',
          modelId: 'claude-sonnet-4-5'
        }
      },
      imageDescriptorAskAgain: true,
      autoRetryAfterReset: true,
      resumeWorkOnRestart: false,
      defaultMergeMethod: 'rebase',
      maxDiffLines: 250,
      agentBehaviorPrompt: 'Custom agent behavior.',
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
    { maxDiffLines: 9 },
    { maxDiffLines: 1.5 },
    { maxDiffLines: 5001 },
    { maxDiffLines: '100' },
    { slashCommandMode: 'both' },
    { preferredEditor: 'unknown-editor' },
    { agentDefaults: { syncFromThreadChanges: 'yes' } },
    { agentDefaults: { syncFromThreadChanges: true, imageDescriptor: { harnessId: 'opencode' } } },
    { imageDescriptorAskAgain: 'yes' },
    { imageDescriptorAskAgain: 1 },
    { autoRetryAfterReset: 'yes' },
    { resumeWorkOnRestart: 'yes' },
    { resumeWorkOnRestart: 1 },
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

    await expect(getHandler?.(trustedEvent())).resolves.toEqual({
      ...defaultConfig,
      lastFolderDialogPath: '/projects'
    })
    await expect(
      updateHandler?.(trustedEvent(), { theme: 'dark', slashCommandMode: 'passthrough' })
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
      syncAgentRoleHandler?.(trustedEvent(), 'worker', {
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
    await expect(
      updateHandler?.(trustedEvent(), { keybindings: { quit: 'cmd+q' } })
    ).rejects.toThrow('Unsupported config field')
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
    await createHandler?.(trustedEvent(), { name: 'CodeInOven', path: '/projects/codeinoven' })

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

    expect(
      handlers.get('brainstorm:ensureWorkflow')?.(trustedEvent(), 'project-1', 'thread-1')
    ).toMatchObject({
      stage: 'choice_pending'
    })
    expect(
      handlers.get('brainstorm:chooseEntry')?.(
        trustedEvent(),
        'project-1',
        'thread-1',
        'brainstorm'
      )
    ).toMatchObject({ entryChoice: 'brainstorm', stage: 'drafting' })
    const draft = (await handlers.get('brainstorm:createDraft')?.(
      trustedEvent(),
      'project-1',
      'thread-1',
      validBrainstormContent,
      { source: 'agent', actor: 'Sr. Engineer' }
    )) as BrainstormDocument
    await expect(
      handlers.get('brainstorm:getActive')?.(trustedEvent(), 'project-1', 'thread-1')
    ).resolves.toEqual(draft)
    expect(
      handlers.get('brainstorm:listVersions')?.(trustedEvent(), 'project-1', 'thread-1', draft.id)
    ).toEqual([draft])
    expect(() =>
      handlers.get('brainstorm:chooseEntry')?.(trustedEvent(), 'project-1', 'thread-1', 'invalid')
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
    const created = (await createDraft?.(
      trustedEvent(),
      'project-1',
      'thread-1',
      validSpecContent,
      {
        source: 'manual',
        actor: 'tester'
      }
    )) as EngineeringSpec

    expect(created.status).toBe('draft')
    await expect(getActive?.(trustedEvent(), 'project-1', 'thread-1')).resolves.toEqual(created)
    await expect(
      listVersions?.(trustedEvent(), 'project-1', 'thread-1', created.id)
    ).resolves.toEqual([created])
    expect(() =>
      createDraft?.(trustedEvent(), '../escape', 'thread-1', validSpecContent, {
        source: 'manual',
        actor: 'tester'
      })
    ).toThrow('Project ID')
    expect(() =>
      createDraft?.(
        trustedEvent(),
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
      trustedEvent(),
      'project-1',
      'thread-1'
    )) as EngineeringSpec
    expect(imported.provenance).toMatchObject({
      source: 'markdown_import',
      importedFilename: 'import.md'
    })
    await expect(handlers.get('spec:exportMarkdown')?.(trustedEvent(), imported)).resolves.toBe(
      exportPath
    )
    await expect(readFile(exportPath, 'utf-8')).resolves.toContain('## Success Criteria')
    expect(showOpenDialog).toHaveBeenCalledOnce()
    expect(showSaveDialog).toHaveBeenCalledOnce()
  })
})

describe('git IPC', () => {
  it('keeps thread.branch coherent when the app drives a checkout', async () => {
    const gitDir = await mkdtemp(join(tmpdir(), 'codeinoven-git-ipc-'))
    const repo = simpleGit(gitDir)
    await repo.init()
    await writeFile(join(gitDir, 'file.txt'), 'hello\n', 'utf-8')
    await repo.add('.')
    await repo.commit('initial')
    await repo.checkoutLocalBranch('feature/git')

    const now = Date.now()
    new ProjectRepo(database).upsert({
      id: 'git-project',
      name: 'Git project',
      path: gitDir,
      source: 'local',
      providerId: 'openai',
      workflowId: 'default',
      threadLimit: 70,
      changeTrackingMode: 'git',
      createdAt: now,
      updatedAt: now
    })
    new ThreadRepo(database).upsert({
      id: 'git-thread',
      projectId: 'git-project',
      providerId: 'openai',
      title: 'Git thread',
      titleSource: 'manual',
      status: 'created',
      pinned: false,
      archived: false,
      read: false,
      createdAt: now,
      updatedAt: now,
      lastActivity: now,
      workingDirectory: gitDir,
      branch: 'main'
    })

    const storage = new StorageEngine()
    registerIpcHandlers(storage, database)

    const checkoutHandler = handlers.get('git:checkout')
    expect(checkoutHandler).toBeDefined()
    await expect(
      checkoutHandler?.(trustedEvent(), 'git-project', 'feature/git')
    ).resolves.toMatchObject({
      branch: 'feature/git'
    })

    const thread = new ThreadRepo(database).get('git-thread')
    expect(thread?.branch).toBe('feature/git')

    await rm(gitDir, { recursive: true, force: true })
  })

  it('exposes git mutation channels incl. amend and reset', async () => {
    const storage = new StorageEngine()
    registerIpcHandlers(storage, database)
    expect(handlers.has('git:status')).toBe(true)
    expect(handlers.has('git:reset')).toBe(true)
    expect(handlers.has('git:amend')).toBe(true)
    expect(handlers.has('git:checkout')).toBe(true)
  })

  it('vaults a git token and returns presence-only over IPC', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'codeinoven-git-cred-'))
    const storage = new StorageEngine(storageRoot)
    registerIpcHandlers(storage, database)

    const setHandler = handlers.get('git:setCredential')
    await expect(
      setHandler?.(trustedEvent(), 'cred-project', 'ghp_plaintext_secret')
    ).resolves.toMatchObject({
      configured: true,
      secureStorageAvailable: true
    })

    const statusHandler = handlers.get('git:getCredentialStatus')
    await expect(statusHandler?.(trustedEvent(), 'cred-project')).resolves.toEqual({
      configured: true,
      secureStorageAvailable: true
    })

    const removeHandler = handlers.get('git:removeCredential')
    await expect(removeHandler?.(trustedEvent(), 'cred-project')).resolves.toEqual({
      configured: false,
      secureStorageAvailable: true
    })

    // The vault store must contain only ciphertext — never the plaintext token.
    const vaultRaw = await readFile(join(storageRoot, 'secrets', 'vault.json'), 'utf-8')
    expect(vaultRaw).not.toContain('ghp_plaintext_secret')

    await rm(storageRoot, { recursive: true, force: true })
  })

  it('surfaces a clear fallback when secure credential storage is unavailable', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'codeinoven-git-cred2-'))
    const storage = new StorageEngine(storageRoot)
    safeStorage.isEncryptionAvailable.mockReturnValue(false)
    registerIpcHandlers(storage, database)

    const statusHandler = handlers.get('git:getCredentialStatus')
    await expect(statusHandler?.(trustedEvent(), 'cred-project')).resolves.toEqual({
      configured: false,
      secureStorageAvailable: false
    })

    const setHandler = handlers.get('git:setCredential')
    await expect(setHandler?.(trustedEvent(), 'cred-project', 'token')).rejects.toThrow(
      'Secure credential storage is unavailable'
    )

    await rm(storageRoot, { recursive: true, force: true })
  })
})

describe('cloudDeploy IPC', () => {
  async function setupStorage(): Promise<string> {
    const storageRoot = await mkdtemp(join(tmpdir(), 'codeinoven-clouddeploy-ipc-'))
    const storage = new StorageEngine(storageRoot)
    registerIpcHandlers(storage, database)
    return storageRoot
  }

  async function createCoolifyAccount(accountLabel: string, token: string): Promise<string> {
    const create = handlers.get('cloudDeploy:createAccount')
    const account = (await create?.(
      trustedEvent(),
      'coolify',
      accountLabel,
      token,
      'http://localhost:8080'
    )) as CloudDeploymentProviderAccount
    return account.id
  }

  it('creates a global account and can attach it to two projects without duplication', async () => {
    const storageRoot = await setupStorage()
    const create = handlers.get('cloudDeploy:createAccount')
    const attach = handlers.get('cloudDeploy:attachAccount')
    const list = handlers.get('cloudDeploy:listAccounts')
    const get = handlers.get('cloudDeploy:getConfig')

    const account = (await create?.(
      trustedEvent(),
      'coolify',
      'Coolify — Personal',
      'personal-token',
      'http://localhost:8080'
    )) as CloudDeploymentProviderAccount
    expect(account.id).toBeTruthy()
    // The secret is never returned to the renderer — only the opaque ref exists in main.
    expect(account.secretRef).toBe('')
    expect(account.configured).toBe(true)
    expect(account.enabled).toBe(true)

    await attach?.(trustedEvent(), 'proj-a', 'coolify', account.id)
    await attach?.(trustedEvent(), 'proj-b', 'coolify', account.id)

    // One global account, referenced by both projects (no per-project copies).
    const registry = (await list?.(trustedEvent())) as {
      accounts: CloudDeploymentProviderAccount[]
    }
    expect(registry.accounts).toHaveLength(1)
    expect(registry.accounts[0].id).toBe(account.id)

    const configA = (await get?.(trustedEvent(), 'proj-a')) as CloudDeploymentConfig
    const configB = (await get?.(trustedEvent(), 'proj-b')) as CloudDeploymentConfig
    expect(configA.project.providerAccounts?.['coolify']?.attachedAccountIds).toContain(account.id)
    expect(configB.project.providerAccounts?.['coolify']?.attachedAccountIds).toContain(account.id)

    // The same token resolves for both projects because it is keyed by account.
    const vaultRaw = await readFile(join(storageRoot, 'secrets', 'vault.json'), 'utf-8')
    expect(vaultRaw).toContain(`deployment_provider_${account.id}`)
    expect(vaultRaw).not.toContain('personal-token')

    await rm(storageRoot, { recursive: true, force: true })
  })

  it('rejects a duplicate global account label', async () => {
    const storageRoot = await setupStorage()
    const create = handlers.get('cloudDeploy:createAccount')
    await create?.(trustedEvent(), 'coolify', 'Personal', 'token-a', 'http://localhost:8080')

    await expect(
      create?.(trustedEvent(), 'coolify', 'Personal', 'token-b', 'http://localhost:8080')
    ).rejects.toThrow(/already exists/i)

    await rm(storageRoot, { recursive: true, force: true })
  })

  it('switches the active attached account and resolves its token + base URL on overview', async () => {
    const storageRoot = await setupStorage()
    const personalId = await createCoolifyAccount('Personal', 'personal-token')
    const companyId = await createCoolifyAccount('Company', 'company-token')
    const attach = handlers.get('cloudDeploy:attachAccount')
    const setActive = handlers.get('cloudDeploy:setActiveAccount')
    const get = handlers.get('cloudDeploy:getConfig')
    const save = handlers.get('cloudDeploy:saveConfig')
    const overview = handlers.get('cloudDeploy:overview')

    await attach?.(trustedEvent(), 'proj-a', 'coolify', personalId)
    await attach?.(trustedEvent(), 'proj-a', 'coolify', companyId)
    await expect(
      setActive?.(trustedEvent(), 'proj-a', 'coolify', companyId)
    ).resolves.toMatchObject({
      project: { providerAccounts: { coolify: { activeAccountId: companyId } } }
    })

    // Map a container so the overview has something to return.
    const config = (await get?.(trustedEvent(), 'proj-a')) as CloudDeploymentConfig
    const now = Date.now()
    const mapped: CloudDeploymentConfig = {
      ...config,
      project: {
        ...config.project,
        providers: ['coolify'],
        containers: [
          {
            id: 'app-1',
            label: 'My App',
            providerKind: 'coolify',
            status: 'unknown',
            createdAt: now,
            updatedAt: now
          }
        ]
      },
      updatedAt: now
    }
    await save?.(trustedEvent(), 'proj-a', mapped)

    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit): Promise<Response> =>
        new Response(
          JSON.stringify([
            {
              uuid: 'app-1',
              name: 'My App',
              status: 'running',
              fqdn: 'https://app.example-host.dev'
            }
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const result = (await overview?.(trustedEvent(), 'proj-a', 'coolify')) as {
        containers: { id: string }[]
        hasDeployments: boolean
      }
      expect(result).toMatchObject({ hasDeployments: true })
      expect(result.containers[0]).toMatchObject({ id: 'app-1' })
      const [url, init] = fetchMock.mock.calls[0]
      expect(String(url)).toContain('http://localhost:8080')
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: 'Bearer company-token'
      })
    } finally {
      vi.unstubAllGlobals()
    }

    await rm(storageRoot, { recursive: true, force: true })
  })

  it('filters provider containers to project mappings and preserves custom labels', async () => {
    const storageRoot = await setupStorage()
    const accountId = await createCoolifyAccount('Personal', 'personal-token')
    const attach = handlers.get('cloudDeploy:attachAccount')
    const save = handlers.get('cloudDeploy:saveConfig')
    const get = handlers.get('cloudDeploy:getConfig')
    const overview = handlers.get('cloudDeploy:overview')

    await attach?.(trustedEvent(), 'proj-a', 'coolify', accountId)
    const existing = (await get?.(trustedEvent(), 'proj-a')) as CloudDeploymentConfig
    const now = Date.now()
    const mapped: CloudDeploymentConfig = {
      ...existing,
      project: {
        ...existing.project,
        providers: ['coolify'],
        containers: [
          {
            id: 'app-1',
            label: 'My Custom API',
            providerKind: 'coolify',
            status: 'unknown',
            createdAt: now,
            updatedAt: now
          },
          {
            id: 'app-not-yet',
            label: 'Pending App',
            providerKind: 'coolify',
            status: 'unknown',
            createdAt: now,
            updatedAt: now
          }
        ]
      },
      updatedAt: now
    }
    await save?.(trustedEvent(), 'proj-a', mapped)

    const fetchMock = vi.fn(async (url: string | URL): Promise<Response> => {
      const path = String(url)
      // The overview resolves project names by fetching /projects + environments.
      if (path.includes('/environments')) {
        return new Response(JSON.stringify([{ id: 7, name: 'production', project_id: 1 }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (path.includes('/projects')) {
        return new Response(JSON.stringify([{ id: 1, uuid: 'proj-milogs', name: 'Milogs' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return new Response(
        JSON.stringify([
          {
            uuid: 'app-1',
            name: 'Provider-Assigned Name',
            environment_id: 7,
            status: 'running',
            fqdn: 'https://app-1.example.dev'
          },
          {
            uuid: 'unrelated-app',
            name: 'Unrelated App',
            status: 'running',
            fqdn: 'https://unrelated.example.dev'
          }
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const result = (await overview?.(trustedEvent(), 'proj-a', 'coolify')) as {
        containers: CloudDeploymentContainer[]
        accessError?: string
      }
      expect(result.accessError).toBeUndefined()
      const ids = result.containers.map((container) => container.id).sort()
      expect(ids).toEqual(['app-1', 'app-not-yet'])
      expect(result.containers).not.toContainEqual(expect.objectContaining({ id: 'unrelated-app' }))
      const live = result.containers.find((container) => container.id === 'app-1')
      expect(live?.label).toBe('My Custom API')
      expect(live?.status).toBe('success')
      expect(live?.project).toBe('Milogs')
      const pending = result.containers.find((container) => container.id === 'app-not-yet')
      expect(pending?.label).toBe('Pending App')
      expect(pending?.status).toBe('unknown')
    } finally {
      vi.unstubAllGlobals()
    }

    await rm(storageRoot, { recursive: true, force: true })
  })

  it('lists available containers the account can see via availableContainers', async () => {
    const storageRoot = await setupStorage()
    const accountId = await createCoolifyAccount('Personal', 'personal-token')
    const attach = handlers.get('cloudDeploy:attachAccount')
    const available = handlers.get('cloudDeploy:availableContainers')
    await attach?.(trustedEvent(), 'proj-a', 'coolify', accountId)

    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit): Promise<Response> =>
        new Response(
          JSON.stringify([
            { uuid: 'app-1', name: 'My App', status: 'running', fqdn: 'https://app.example.dev' },
            {
              uuid: 'app-2',
              name: 'Other App',
              status: 'stopped',
              fqdn: 'https://other.example.dev'
            }
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const result = (await available?.(
        trustedEvent(),
        'proj-a',
        'coolify'
      )) as CloudDeploymentContainer[]
      expect(Array.isArray(result)).toBe(true)
      const ids = (result as CloudDeploymentContainer[]).map((container) => container.id)
      expect(ids).toEqual(['app-1', 'app-2'])
    } finally {
      vi.unstubAllGlobals()
    }

    await rm(storageRoot, { recursive: true, force: true })
  })

  it('lists recent deployments for a container via deployments', async () => {
    const storageRoot = await setupStorage()
    const accountId = await createCoolifyAccount('Personal', 'personal-token')
    const attach = handlers.get('cloudDeploy:attachAccount')
    const deployments = handlers.get('cloudDeploy:deployments')
    await attach?.(trustedEvent(), 'proj-a', 'coolify', accountId)

    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit): Promise<Response> =>
        new Response(
          JSON.stringify([
            {
              deployment_uuid: 'dep-1',
              status: 'finished',
              updated_at: '2024-01-02T00:00:00.000Z',
              commit: 'abc1234'
            },
            {
              deployment_uuid: 'dep-2',
              status: 'failed',
              updated_at: '2024-01-01T00:00:00.000Z'
            }
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const result = (await deployments?.(
        trustedEvent(),
        'proj-a',
        'coolify',
        'app-1'
      )) as CloudDeploymentDeployment[]
      expect(result).toHaveLength(2)
      expect(result[0]).toMatchObject({ id: 'dep-1', status: 'success', commit: 'abc1234' })
      expect(result[1]).toMatchObject({ id: 'dep-2', status: 'failed' })
    } finally {
      vi.unstubAllGlobals()
    }

    await rm(storageRoot, { recursive: true, force: true })
  })

  it('updates and removes a container in a project config', async () => {
    const storageRoot = await setupStorage()
    const accountId = await createCoolifyAccount('Personal', 'personal-token')
    const attach = handlers.get('cloudDeploy:attachAccount')
    const save = handlers.get('cloudDeploy:saveConfig')
    const get = handlers.get('cloudDeploy:getConfig')
    const update = handlers.get('cloudDeploy:updateContainer')
    const remove = handlers.get('cloudDeploy:removeContainer')
    await attach?.(trustedEvent(), 'proj-a', 'coolify', accountId)

    const now = Date.now()
    await save?.(trustedEvent(), 'proj-a', {
      version: 3,
      projectId: 'proj-a',
      project: {
        providers: ['coolify'],
        containers: [
          {
            id: 'app-1',
            label: 'Old Label',
            providerKind: 'coolify',
            status: 'unknown',
            createdAt: now,
            updatedAt: now
          }
        ]
      },
      updatedAt: now
    } as CloudDeploymentConfig)

    // Update the label.
    await update?.(trustedEvent(), 'proj-a', 'coolify', 'app-1', { label: 'New Label' })
    let config = (await get?.(trustedEvent(), 'proj-a')) as CloudDeploymentConfig
    expect(config.project.containers[0]).toMatchObject({ id: 'app-1', label: 'New Label' })

    // Remove it.
    await remove?.(trustedEvent(), 'proj-a', 'coolify', 'app-1')
    config = (await get?.(trustedEvent(), 'proj-a')) as CloudDeploymentConfig
    expect(config.project.containers).toHaveLength(0)

    await rm(storageRoot, { recursive: true, force: true })
  })

  it('rejects container mappings whose provider is not selected', async () => {
    const storageRoot = await setupStorage()
    const save = handlers.get('cloudDeploy:saveConfig')
    const now = Date.now()
    const config: CloudDeploymentConfig = {
      version: 3,
      projectId: 'proj-a',
      project: {
        providers: ['coolify'],
        containers: [
          {
            id: 'app-1',
            label: 'My App',
            providerKind: 'netlify',
            status: 'unknown',
            createdAt: now,
            updatedAt: now
          }
        ]
      },
      updatedAt: now
    }

    await expect(save?.(trustedEvent(), 'proj-a', config)).rejects.toThrow(/not selected/i)

    await rm(storageRoot, { recursive: true, force: true })
  })

  it('rejects duplicate container mappings for the same provider and id', async () => {
    const storageRoot = await setupStorage()
    const save = handlers.get('cloudDeploy:saveConfig')
    const now = Date.now()
    const config: CloudDeploymentConfig = {
      version: 3,
      projectId: 'proj-a',
      project: {
        providers: ['coolify'],
        containers: [
          {
            id: 'app-1',
            label: 'First',
            providerKind: 'coolify',
            status: 'unknown',
            createdAt: now,
            updatedAt: now
          },
          {
            id: 'app-1',
            label: 'Second',
            providerKind: 'coolify',
            status: 'unknown',
            createdAt: now,
            updatedAt: now
          }
        ]
      },
      updatedAt: now
    }

    await expect(save?.(trustedEvent(), 'proj-a', config)).rejects.toThrow(/Duplicate/i)

    await rm(storageRoot, { recursive: true, force: true })
  })

  it('rotates a global account secret and never returns it', async () => {
    const storageRoot = await setupStorage()
    const accountId = await createCoolifyAccount('Personal', 'old-token')
    const rotate = handlers.get('cloudDeploy:rotateAccountSecret')
    const list = handlers.get('cloudDeploy:listAccounts')

    const rotated = (await rotate?.(
      trustedEvent(),
      accountId,
      'new-token'
    )) as CloudDeploymentProviderAccount
    // The secret must never be returned to the renderer.
    expect(rotated.secretRef).toBe('')

    const vaultRaw = await readFile(join(storageRoot, 'secrets', 'vault.json'), 'utf-8')
    expect(vaultRaw).not.toContain('new-token')
    const registry = (await list?.(trustedEvent())) as {
      accounts: CloudDeploymentProviderAccount[]
    }
    const account = registry.accounts.find((entry) => entry.id === accountId)
    expect(account?.configured).toBe(true)

    await rm(storageRoot, { recursive: true, force: true })
  })

  it('removes a global account and its vault token', async () => {
    const storageRoot = await setupStorage()
    const accountId = await createCoolifyAccount('Personal', 'personal-token')
    const remove = handlers.get('cloudDeploy:removeAccount')
    const list = handlers.get('cloudDeploy:listAccounts')

    await remove?.(trustedEvent(), accountId)

    const registry = (await list?.(trustedEvent())) as {
      accounts: CloudDeploymentProviderAccount[]
    }
    expect(registry.accounts).toHaveLength(0)
    const vaultRaw = await readFile(join(storageRoot, 'secrets', 'vault.json'), 'utf-8')
    expect(vaultRaw).not.toContain(`deployment_provider_${accountId}`)

    await rm(storageRoot, { recursive: true, force: true })
  })
})
