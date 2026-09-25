import { BrowserWindow, dialog } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { APP_NAME, APP_SLUG } from '../../../lib/brand'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import { modelKey } from '../../../lib/model-keys'
import { INBOX_PROJECT_ID } from '../../../lib/types'
import {
  parseMemoryExport,
  serializeMemoryExport,
  validateMemoryExportKind
} from '../../chat/memory-service'
import { validateEntityId } from '../ipc-validation'
import { isRecord, requireString } from './shared'
import { validateMemoryEntries, optionalMemoryEntityId } from './spec-helpers'
import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import type { MemoryEntry, MemoryScope } from '../../../lib/types'
import type { IpcHandlerContext } from './context'

export function registerMemoryHandlers(ctx: IpcHandlerContext): void {
  const {
    storage,
    projectManager,
    threadManager,
    engineeringLifecycleEngine,
    specEngine,
    memoryService
  } = ctx

  // ─── Memory ────────────────────────────────────────────────────────────
  ipcMain.handle('memory:getLayers', async (_, projectId: unknown, threadId: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    const safeThreadId = validateEntityId(threadId, 'Thread ID')
    const project = await projectManager.getProject(safeProjectId)
    if (!project) throw new Error(`Project not found: ${safeProjectId}`)
    const projectPath = project.path || ''
    const thread = await threadManager.getThread(safeProjectId, safeThreadId)
    const { PromptAssembler } = await import('../../chat/prompt-assembler')
    const assembler = new PromptAssembler(memoryService)
    const {
      SPEC_BRAINSTORM_SYSTEM_PROMPT,
      SPEC_IMPLEMENT_SYSTEM_PROMPT,
      MERMAID_OUTPUT_INSTRUCTION
    } = await import('../../chat/chat-engine')
    const driverName =
      thread?.settings?.harnessId === 'claude-code'
        ? 'Claude Code'
        : thread?.settings?.harnessId === 'codex'
          ? 'Codex'
          : thread?.settings?.harnessId === 'cline'
            ? 'Cline'
            : thread?.settings?.harnessId === 'pi'
              ? 'Pi'
              : thread?.settings?.harnessId === 'antigravity'
                ? 'Antigravity'
                : thread?.settings?.harnessId === 'muse'
                  ? 'Muse Code'
                  : 'OpenCode'
    const harnessId = thread?.settings?.harnessId ?? DEFAULT_HARNESS
    const driverInfo = {
      id: harnessId,
      name: driverName
    }
    const workflow = await specEngine.getWorkflowState(safeProjectId, safeThreadId)
    const hasActiveSpec = Boolean(workflow?.activeSpecId && workflow.activeSpecVersion)
    const lifecycle = engineeringLifecycleEngine.get(safeProjectId, safeThreadId)
    const engineeringActive =
      lifecycle !== null &&
      ((lifecycle.selection ?? 'none') !== 'none' || lifecycle.startedAt !== undefined)
    const mode = !engineeringActive ? 'chat' : hasActiveSpec ? 'brainstorm' : 'implement'
    return assembler.getLayers(
      safeProjectId,
      safeThreadId,
      projectPath,
      driverInfo,
      {
        SPEC_BRAINSTORM_SYSTEM_PROMPT,
        SPEC_IMPLEMENT_SYSTEM_PROMPT,
        MERMAID_OUTPUT_INSTRUCTION
      },
      mode,
      (await storage.getConfig()).agentBehaviorPrompt,
      thread?.settings?.providerId && thread.settings.modelId
        ? modelKey(harnessId, thread.settings.providerId, thread.settings.modelId)
        : undefined,
      safeProjectId === INBOX_PROJECT_ID ? 'standalone-chat' : 'project-thread',
      'full',
      thread?.routineId
    )
  })
  ipcMain.handle('memory:getRaw', (_, projectId?: unknown, threadId?: unknown) =>
    memoryService.getRawMarkdown(
      optionalMemoryEntityId(projectId, 'Project ID'),
      optionalMemoryEntityId(threadId, 'Thread ID')
    )
  )
  ipcMain.handle(
    'memory:saveRaw',
    async (_, markdown: unknown, projectId?: unknown, threadId?: unknown) => {
      await memoryService.saveFromMarkdown(
        requireString(markdown, 'Memory markdown', true),
        optionalMemoryEntityId(projectId, 'Project ID'),
        optionalMemoryEntityId(threadId, 'Thread ID')
      )
    }
  )
  ipcMain.handle('memory:getEntries', (_, projectId?: unknown, threadId?: unknown) =>
    memoryService.getEntries(
      optionalMemoryEntityId(projectId, 'Project ID'),
      optionalMemoryEntityId(threadId, 'Thread ID')
    )
  )
  ipcMain.handle(
    'memory:saveEntries',
    async (_, entries: unknown, projectId?: unknown, threadId?: unknown) => {
      const safe = validateMemoryEntries(entries)
      await memoryService.saveEntries(
        safe,
        optionalMemoryEntityId(projectId, 'Project ID'),
        optionalMemoryEntityId(threadId, 'Thread ID')
      )
    }
  )
  ipcMain.handle('memory:getMergedEntries', (_, projectId: unknown) =>
    memoryService.getMergedEntries(requireString(projectId, 'Project ID', true))
  )
  ipcMain.handle(
    'memory:addEntry',
    async (_, label: unknown, content: unknown, options?: unknown) => {
      const safeLabel = requireString(label, 'Memory label', true)
      const safeContent = requireString(content, 'Memory content', true)
      const opts = isRecord(options) ? options : {}
      return memoryService.addEntry(safeLabel, safeContent, {
        category:
          typeof opts.category === 'string'
            ? (opts.category as MemoryEntry['category'])
            : undefined,
        priority:
          typeof opts.priority === 'string'
            ? (opts.priority as MemoryEntry['priority'])
            : undefined,
        scopes: Array.isArray(opts.scopes) ? (opts.scopes as MemoryScope[]) : undefined,
        source:
          typeof opts.source === 'string' ? (opts.source as MemoryEntry['source']) : undefined,
        modelKeys: Array.isArray(opts.modelKeys) ? (opts.modelKeys as string[]) : undefined,
        projectId: optionalMemoryEntityId(opts.projectId, 'Project ID'),
        threadId: optionalMemoryEntityId(opts.threadId, 'Thread ID'),
        routineId: optionalMemoryEntityId(opts.routineId, 'Routine ID')
      })
    }
  )
  ipcMain.handle(
    'memory:removeEntry',
    async (_, entryId: unknown, projectId?: unknown, threadId?: unknown) =>
      memoryService.removeEntry(
        requireString(entryId, 'Entry ID', true),
        optionalMemoryEntityId(projectId, 'Project ID'),
        optionalMemoryEntityId(threadId, 'Thread ID')
      )
  )
  ipcMain.handle('memory:searchEntries', async (_, query: unknown, options?: unknown) => {
    const safeQuery = requireString(query, 'Search query', true)
    const opts = isRecord(options) ? options : {}
    return memoryService.searchEntries(safeQuery, {
      category:
        typeof opts.category === 'string' ? (opts.category as MemoryEntry['category']) : undefined,
      priority:
        typeof opts.priority === 'string' ? (opts.priority as MemoryEntry['priority']) : undefined,
      projectId: optionalMemoryEntityId(opts.projectId, 'Project ID')
    })
  })
  ipcMain.handle('memory:getPendingProposals', (_, projectId?: unknown) =>
    memoryService.getPendingProposals(optionalMemoryEntityId(projectId, 'Project ID'))
  )
  ipcMain.handle('memory:approveProposal', async (_, proposalId: unknown, projectId?: unknown) =>
    memoryService.approveProposal(
      requireString(proposalId, 'Proposal ID', true),
      optionalMemoryEntityId(projectId, 'Project ID')
    )
  )
  ipcMain.handle('memory:rejectProposal', async (_, proposalId: unknown, projectId?: unknown) =>
    memoryService.rejectProposal(
      requireString(proposalId, 'Proposal ID', true),
      optionalMemoryEntityId(projectId, 'Project ID')
    )
  )
  ipcMain.handle(
    'memory:createProposal',
    async (_, label: unknown, content: unknown, options?: unknown) => {
      const safeLabel = requireString(label, 'Memory label', true)
      const safeContent = requireString(content, 'Memory content', true)
      const opts = isRecord(options) ? options : {}
      return memoryService.createProposal(safeLabel, safeContent, {
        category:
          typeof opts.category === 'string'
            ? (opts.category as MemoryEntry['category'])
            : undefined,
        priority:
          typeof opts.priority === 'string'
            ? (opts.priority as MemoryEntry['priority'])
            : undefined,
        scopes: Array.isArray(opts.scopes) ? (opts.scopes as MemoryScope[]) : undefined,
        modelKeys: Array.isArray(opts.modelKeys) ? (opts.modelKeys as string[]) : undefined,
        projectId: optionalMemoryEntityId(opts.projectId, 'Project ID'),
        threadId: optionalMemoryEntityId(opts.threadId, 'Thread ID'),
        routineId: optionalMemoryEntityId(opts.routineId, 'Routine ID')
      })
    }
  )

  ipcMain.handle('memory:export', async (_, kind: unknown, projectId?: unknown) => {
    const scope = validateMemoryExportKind(kind, projectId)
    const entries = await memoryService.exportEntries(scope.kind, scope.projectId)
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    const defaultPath = `${APP_SLUG}-memory-${scope.kind}-${new Date().toISOString().slice(0, 10)}.json`
    const result = win
      ? await dialog.showSaveDialog(win, {
          title: `Export ${APP_NAME} Memory`,
          defaultPath,
          filters: [{ name: 'Memory Export', extensions: ['json'] }]
        })
      : await dialog.showSaveDialog({
          title: `Export ${APP_NAME} Memory`,
          defaultPath,
          filters: [{ name: 'Memory Export', extensions: ['json'] }]
        })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, serializeMemoryExport({ ...scope, entries }), 'utf-8')
    return result.filePath
  })

  ipcMain.handle('memory:import', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: `Import ${APP_NAME} Memory`,
          properties: ['openFile'],
          filters: [{ name: 'Memory Export', extensions: ['json'] }]
        })
      : await dialog.showOpenDialog({
          title: `Import ${APP_NAME} Memory`,
          properties: ['openFile'],
          filters: [{ name: 'Memory Export', extensions: ['json'] }]
        })
    if (result.canceled || result.filePaths.length === 0) return null
    const raw = await readFile(result.filePaths[0], 'utf-8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new TypeError('The selected file is not valid JSON')
    }
    return parseMemoryExport(parsed)
  })

  ipcMain.handle(
    'memory:importApply',
    async (_, preview: unknown, kind: unknown, projectId?: unknown) => {
      const safePreview = parseMemoryExport(preview)
      const scope = validateMemoryExportKind(kind, projectId)
      return memoryService.importEntries(safePreview.entries, {
        kind: scope.kind,
        projectId: scope.projectId
      })
    }
  )
}
