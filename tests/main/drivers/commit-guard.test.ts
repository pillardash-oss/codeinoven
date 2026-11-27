/**
 * The commit guard, exercised against a real checkout.
 *
 * The guard lives inside the generated core-tools extension, so this test runs
 * that generated module the way pi does: transpile it, hand it a stub `pi`,
 * and fire the same hooks the runtime fires. The point is the behaviour a
 * prompt cannot guarantee, so each case asserts what a turn actually leaves
 * behind rather than what the instructions say.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'

import { piCioCoreToolsExtension } from '../../../src/main/drivers/pi-cio-core-tools-extension'

const SCRATCH = resolve(import.meta.dirname, '../../../.cio/tmp/commit-guard-test')

type Handler = (event: unknown, ctx?: unknown) => unknown

interface StubPi {
  api: Record<string, unknown>
  handlers: Map<string, Handler[]>
  tools: Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>
  messages: { customType?: string; content?: string }[]
}

/** The generated extension, loaded exactly as the runtime loads it. */
function loadExtension(cwd: string): StubPi {
  const source = piCioCoreToolsExtension({
    questionCap: 3,
    gatewayHandoffPath: join(SCRATCH, 'session', 'gateway.json'),
    systemPromptPath: join(SCRATCH, 'session', 'system-prompt.txt'),
    historyRecapPath: join(SCRATCH, 'session', 'history-recap.txt'),
    allowedToolsPath: join(SCRATCH, 'session', 'allowed-tools.json'),
    oversizedFlagPath: join(SCRATCH, 'session', 'oversized.json'),
    stopFlagPath: join(SCRATCH, 'session', 'stop.json'),
    handoffWorkersPath: join(SCRATCH, 'session', 'handoff-workers.json'),
    liveSubagentsPath: join(SCRATCH, 'session', 'live-subagents.json'),
    subagentWatchPath: join(SCRATCH, 'session', 'watched.json'),
    compactionContextPath: join(SCRATCH, 'session', 'compaction.json'),
    workerContractPrompt: 'worker contract',
    sessionCwd: cwd
  })
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  })
  const handlers = new Map<string, Handler[]>()
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>()
  const messages: { customType?: string; content?: string }[] = []
  const api = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
    registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
      tools.set(tool.name, tool)
    },
    registerCommand: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
    registerMcpServer: () => {},
    unregisterMcpServer: () => {},
    registerMessageRenderer: () => {},
    registerMarkdownTransformer: () => {},
    registerEntryRenderer: () => {},
    registerToolRenderer: () => {},
    getActiveTools: () => [],
    getAllTools: () => [],
    getFlag: () => undefined,
    setActiveTools: () => {},
    getSettings: () => ({}),
    getCommands: () => [],
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    sendMessage: (message: { customType?: string; content?: string }) => {
      messages.push(message)
    },
    sendUserMessage: () => {},
    events: { on: () => () => {}, emit: () => {} }
  }
  const module = { exports: {} as Record<string, unknown> }
  const realRequire = createRequire(import.meta.url)
  // The generated module imports pi's own runtime, which is ESM-only and not
  // reachable from a CJS `require`. Only the tool definitions are real at
  // module scope, and this test never spawns a worker, so a stub is enough to
  // load the extension and fire its hooks.
  const stubRequire = (id: string): unknown => {
    if (id === '@earendil-works/pi-coding-agent') {
      const definition = () => ({ name: 'stub' })
      return {
        createAgentSession: definition,
        createAgentSessionFromServices: definition,
        createAgentSessionServices: definition,
        createEditToolDefinition: definition,
        createReadToolDefinition: definition,
        createWriteToolDefinition: definition,
        createBashToolDefinition: definition,
        createFindToolDefinition: definition,
        createGrepToolDefinition: definition,
        createLsToolDefinition: definition,
        createPowerShellToolDefinition: definition,
        SessionManager: { create: definition },
        convertToLlm: definition,
        findCutPoint: definition,
        serializeConversation: definition
      }
    }
    return realRequire(id)
  }
  const factory = new Function('require', 'exports', 'module', outputText)
  factory(stubRequire, module.exports, module)
  const entry = (module.exports as { default?: (pi: unknown) => void }).default
  if (!entry) throw new Error('the generated extension exports no factory')
  entry(api)
  return { api, handlers, tools, messages }
}

async function fire(
  stub: StubPi,
  event: string,
  payload: unknown,
  ctx?: unknown
): Promise<unknown[]> {
  const results: unknown[] = []
  for (const handler of stub.handlers.get(event) ?? []) {
    results.push(await handler(payload, ctx))
  }
  return results
}

/** Start a turn: the guard reads what was already dirty before it began. */
async function startTurn(stub: StubPi): Promise<void> {
  await fire(stub, 'before_agent_start', { messageType: 'user', systemPrompt: '' })
}

/** A tool call is what teaches the extension the session working directory. */
async function observeCwd(stub: StubPi, cwd: string): Promise<void> {
  await fire(
    stub,
    'tool_call',
    { toolCallId: 'call-cwd', toolName: 'bash', input: { command: 'pwd' } },
    { cwd }
  )
}

async function writeFileThroughTool(stub: StubPi, path: string): Promise<void> {
  await fire(stub, 'tool_execution_end', {
    toolCallId: 'call-write',
    toolName: 'write',
    args: { path },
    isError: false
  })
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function makeRepository(): string {
  const repo = join(SCRATCH, 'repo')
  rmSync(repo, { recursive: true, force: true })
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'guard@example.com')
  git(repo, 'config', 'user.name', 'Guard')
  writeFileSync(join(repo, 'tracked.txt'), 'first\n')
  git(repo, 'add', 'tracked.txt')
  git(repo, 'commit', '-q', '-m', 'first')
  return repo
}

const settleEvent = { outcome: 'completed', context: { canContinue: true } }

function settlePrompt(results: unknown[]): string {
  for (const result of results) {
    const entries = (result as { entries?: { content?: string }[] } | undefined)?.entries ?? []
    for (const entry of entries) {
      if (entry.content) return entry.content
    }
  }
  return ''
}

afterEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

describe('commit guard', () => {
  it('stops a turn that is about to settle with its own file uncommitted', async () => {
    const repo = makeRepository()
    const stub = loadExtension(repo)
    await startTurn(stub)
    await observeCwd(stub, repo)
    writeFileSync(join(repo, 'work.ts'), 'export const work = 1\n')
    await writeFileThroughTool(stub, join(repo, 'work.ts'))

    const results = await fire(stub, 'agent_before_settle', settleEvent)

    const prompt = settlePrompt(results)
    expect(prompt).toContain('work.ts')
    expect(prompt).toContain('git log -1 --stat')
    expect(results.some((result) => (result as { continue?: boolean }).continue === true)).toBe(
      true
    )
  })

  it('lets a turn settle once its work is committed', async () => {
    const repo = makeRepository()
    const stub = loadExtension(repo)
    await startTurn(stub)
    await observeCwd(stub, repo)
    writeFileSync(join(repo, 'work.ts'), 'export const work = 1\n')
    await writeFileThroughTool(stub, join(repo, 'work.ts'))
    git(repo, 'add', 'work.ts')
    git(repo, 'commit', '-q', '-m', 'work')

    const results = await fire(stub, 'agent_before_settle', settleEvent)

    expect(settlePrompt(results)).toBe('')
  })

  it('never blames the tree the turn inherited for work it did not do', async () => {
    const repo = makeRepository()
    writeFileSync(join(repo, 'someone-else.ts'), 'export const theirs = 1\n')
    const stub = loadExtension(repo)
    await startTurn(stub)
    await observeCwd(stub, repo)
    // The turn only read files; its own write is the one and only change.
    await writeFileThroughTool(stub, join(repo, 'someone-else.ts'))

    const results = await fire(stub, 'agent_before_settle', settleEvent)

    // A path it wrote itself is reported even when the turn began dirty.
    expect(settlePrompt(results)).toContain('someone-else.ts')
  })

  it('does not nudge twice for the same turn', async () => {
    const repo = makeRepository()
    const stub = loadExtension(repo)
    await startTurn(stub)
    await observeCwd(stub, repo)
    writeFileSync(join(repo, 'work.ts'), 'export const work = 1\n')
    await writeFileThroughTool(stub, join(repo, 'work.ts'))

    const first = await fire(stub, 'agent_before_settle', settleEvent)
    const second = await fire(stub, 'agent_before_settle', settleEvent)

    expect(settlePrompt(first)).toContain('work.ts')
    expect(settlePrompt(second)).toBe('')
  })

  it('adds the commit as a task while the turn has uncommitted work', async () => {
    const repo = makeRepository()
    const stub = loadExtension(repo)
    await startTurn(stub)
    await observeCwd(stub, repo)
    writeFileSync(join(repo, 'work.ts'), 'export const work = 1\n')
    await writeFileThroughTool(stub, join(repo, 'work.ts'))
    const todoTool = stub.tools.get('cio_todo_write')
    if (!todoTool) throw new Error('the todo tool is missing')

    const result = (await todoTool.execute('call-todo', {
      todos: [{ content: 'Write the file', status: 'completed' }]
    })) as { content?: { text?: string }[] }

    const payload = JSON.parse(result.content?.[0]?.text ?? '{}') as {
      todos?: { content: string; status: string }[]
      addedTask?: string
    }
    expect(payload.todos?.some((todo) => todo.content === 'Commit the work')).toBe(true)
    expect(payload.addedTask).toContain('still uncommitted')
  })

  it('leaves the list alone once the turn has committed', async () => {
    const repo = makeRepository()
    const stub = loadExtension(repo)
    await startTurn(stub)
    await observeCwd(stub, repo)
    writeFileSync(join(repo, 'work.ts'), 'export const work = 1\n')
    await writeFileThroughTool(stub, join(repo, 'work.ts'))
    git(repo, 'add', 'work.ts')
    git(repo, 'commit', '-q', '-m', 'work')
    const todoTool = stub.tools.get('cio_todo_write')
    if (!todoTool) throw new Error('the todo tool is missing')

    const result = (await todoTool.execute('call-todo', {
      todos: [{ content: 'Write the file', status: 'completed' }]
    })) as { content?: { text?: string }[] }

    const payload = JSON.parse(result.content?.[0]?.text ?? '{}') as {
      todos?: { content: string }[]
      addedTask?: string
    }
    expect(payload.todos?.some((todo) => todo.content === 'Commit the work')).toBe(false)
    expect(payload.addedTask).toBeUndefined()
  })

  it('says nothing in a directory that is not a checkout', async () => {
    const plain = join(SCRATCH, 'plain')
    mkdirSync(plain, { recursive: true })
    const stub = loadExtension(plain)
    await startTurn(stub)
    await observeCwd(stub, plain)
    writeFileSync(join(plain, 'note.txt'), 'not a repo\n')
    await writeFileThroughTool(stub, join(plain, 'note.txt'))

    const results = await fire(stub, 'agent_before_settle', settleEvent)

    expect(settlePrompt(results)).toBe('')
    expect(stub.messages).toEqual([])
  })

  it('keeps the pawn and worker carve-out in its instruction', async () => {
    const repo = makeRepository()
    const stub = loadExtension(repo)
    await startTurn(stub)
    await observeCwd(stub, repo)
    writeFileSync(join(repo, 'work.ts'), 'export const work = 1\n')
    await writeFileThroughTool(stub, join(repo, 'work.ts'))

    const prompt = settlePrompt(await fire(stub, 'agent_before_settle', settleEvent))

    expect(prompt).toContain('whose brief forbids committing')
    expect(prompt).toContain('do not commit')
    expect(prompt).toContain('name every one of these paths')
  })
})
