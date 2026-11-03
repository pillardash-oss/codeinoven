import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RunReceiptService } from '../../src/main/chat/run-receipt-service'
import { RunBaseRecorder } from '../../src/main/chat/run-receipt/run-receipt-base'
import { RunReceiptCache } from '../../src/main/chat/run-receipt/run-receipt-cache'
import { parseNameStatus, parseNumstat } from '../../src/main/git/git/git-service-ranges'
import { GitService } from '../../src/main/git/git-service'
import type { ReceiptGit } from '../../src/main/chat/run-receipt/run-receipt-git'
import type { ScopeBoard, Thread } from '../../src/lib/types'
import { ASSISTANT_SPACE_ID, DEFAULT_SCOPE_BUCKET_ID } from '../../src/lib/types'

/**
 * The receipt service, at the layer that can actually fail.
 *
 * The Git port is faked so every case can count calls: a regression to one read
 * per file has to fail loudly here rather than look fine on a small repository.
 * The parser cases and one end-to-end range read run against a real temporary
 * repository, because range parsing is the part a fake cannot vouch for.
 */

const PROJECT_ID = 'project1'
const THREAD_ID = 'thread1'

function board(): ScopeBoard {
  return {
    version: 2,
    buckets: [
      {
        id: DEFAULT_SCOPE_BUCKET_ID,
        name: 'Default',
        sortOrder: 0,
        collapsed: false,
        collapsedSlices: [],
        root: { kind: 'project' }
      }
    ],
    worktreeDefaults: { setupCommands: [], runSetupByDefault: true, environmentMode: 'copy' }
  }
}

interface GitCounts {
  status: number
  log: number
  rangeFiles: number
}

function fakeGit(counts: GitCounts, head = 'head1'): ReceiptGit {
  const log = [
    { hash: head, shortHash: head.slice(0, 7), message: 'A change', author: 'Ada', date: 2 },
    { hash: 'base1', shortHash: 'base1', message: 'The base', author: 'Ada', date: 1 }
  ]
  return {
    async getStatus() {
      counts.status += 1
      return {
        repositoryRoot: '/tmp/project',
        branch: 'dev',
        detached: false,
        upstream: null,
        conflictState: 'none',
        clean: true,
        changes: [],
        stagedChanges: 0,
        unstagedChanges: 0,
        untrackedChanges: 0,
        conflicted: [],
        ahead: 0,
        behind: 0,
        prResolveSession: null
      }
    },
    async log() {
      counts.log += 1
      return log
    },
    async rangeFiles(_path, from, to) {
      counts.rangeFiles += 1
      return [
        {
          path: to === undefined ? 'src/left.ts' : 'src/changed.ts',
          status: 'modified',
          additions: from === 'HEAD' ? 1 : 4,
          deletions: 2,
          binary: false
        }
      ]
    }
  }
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: THREAD_ID,
    projectId: ASSISTANT_SPACE_ID,
    providerId: 'pi',
    title: 'A run',
    titleSource: 'manual',
    status: 'completed',
    pinned: false,
    archived: false,
    read: true,
    assistantId: 'assistant1',
    boundScope: { projectId: PROJECT_ID, scopeBucketId: DEFAULT_SCOPE_BUCKET_ID },
    runBase: {
      sha: 'base1',
      projectId: PROJECT_ID,
      scopeBucketId: DEFAULT_SCOPE_BUCKET_ID,
      recordedAt: 1
    },
    createdAt: 1,
    updatedAt: 1,
    lastActivity: 1,
    workingDirectory: '/tmp/project',
    ...overrides
  }
}

function service(
  options: {
    git?: ReceiptGit
    counts?: GitCounts
    value?: Thread | null
    cache?: RunReceiptCache
  } = {}
): { service: RunReceiptService; counts: GitCounts; setThread: (thread: Thread | null) => void } {
  const counts = options.counts ?? { status: 0, log: 0, rangeFiles: 0 }
  let current = options.value === undefined ? thread() : options.value
  const runBaseRecorder = new RunBaseRecorder({
    getThread: async () => current,
    setRunBase: async () => undefined
  })
  const instance = new RunReceiptService({
    git: options.git ?? fakeGit(counts),
    threads: { getThread: async () => current },
    checks: { listToolMessageParts: async () => [] },
    resolveRoot: async () => '/tmp/project',
    scopeBoard: async () => board(),
    bases: runBaseRecorder,
    ...(options.cache ? { cache: options.cache } : {})
  })
  return { service: instance, counts, setThread: (next) => (current = next) }
}

describe('RunReceiptService', () => {
  it('reads one status, one log and the bounded ranges for a five-file receipt', async () => {
    const { service: receipts, counts } = service()
    const receipt = await receipts.read({ projectId: ASSISTANT_SPACE_ID, threadId: THREAD_ID })
    expect(receipt.state).toBe('ready')
    expect(receipt.commits).toHaveLength(1)
    expect(receipt.commits[0]?.hash).toBe('head1')
    expect(receipt.files).toHaveLength(1)
    expect(receipt.uncommitted).toHaveLength(1)
    expect(receipt.scope.scopeName).toBe('Default')
    expect(receipt.scope.branch).toBe('dev')
    // The run's own range and the working tree, and never a read per file.
    expect(counts).toEqual({ status: 1, log: 1, rangeFiles: 2 })
  })

  it('reads the bound scope rather than the assistant space', async () => {
    const resolveRoot = vi.fn(async () => '/tmp/project')
    const runBaseRecorder = new RunBaseRecorder({
      getThread: async () => thread(),
      setRunBase: async () => undefined
    })
    const receipts = new RunReceiptService({
      git: fakeGit({ status: 0, log: 0, rangeFiles: 0 }),
      threads: { getThread: async () => thread() },
      checks: { listToolMessageParts: async () => [] },
      resolveRoot,
      scopeBoard: async () => board(),
      bases: runBaseRecorder
    })
    const receipt = await receipts.read({ projectId: ASSISTANT_SPACE_ID, threadId: THREAD_ID })
    expect(resolveRoot).toHaveBeenCalledWith(PROJECT_ID, DEFAULT_SCOPE_BUCKET_ID)
    expect(receipt.scope.projectId).toBe(PROJECT_ID)
  })

  it('reports a run with no base instead of borrowing today', async () => {
    const { service: receipts, counts } = service({
      value: thread({ runBase: undefined })
    })
    const receipt = await receipts.read({ projectId: ASSISTANT_SPACE_ID, threadId: THREAD_ID })
    expect(receipt.state).toBe('no-base')
    expect(receipt.baseSha).toBeNull()
    expect(receipt.headSha).toBeNull()
    expect(receipt.files).toEqual([])
    // Nothing was read: there is no range to read.
    expect(counts).toEqual({ status: 0, log: 0, rangeFiles: 0 })
  })

  it('reports a still-running run as running', async () => {
    const { service: receipts } = service({ value: thread({ status: 'executing' }) })
    const receipt = await receipts.read({ projectId: ASSISTANT_SPACE_ID, threadId: THREAD_ID })
    expect(receipt.state).toBe('running')
    expect(receipt.checks).toEqual([])
  })

  it('reports an unreadable repository as an error rather than an empty receipt', async () => {
    const git = fakeGit({ status: 0, log: 0, rangeFiles: 0 })
    git.getStatus = async () => {
      throw new Error('not a git repository')
    }
    const { service: receipts } = service({ git })
    const receipt = await receipts.read({ projectId: ASSISTANT_SPACE_ID, threadId: THREAD_ID })
    expect(receipt.state).toBe('error')
    expect(receipt.reason).toContain('not a git repository')
  })

  it('reports a missing thread as an error it cannot describe', async () => {
    const { service: receipts } = service({ value: null })
    const receipt = await receipts.read({ projectId: ASSISTANT_SPACE_ID, threadId: THREAD_ID })
    expect(receipt.state).toBe('error')
    expect(receipt.reason).toBeDefined()
  })
})

describe('receipt performance guardrails', () => {
  it('performs no git call on a repeated read of an unchanged range', async () => {
    const { service: receipts, counts } = service()
    await receipts.read({ projectId: ASSISTANT_SPACE_ID, threadId: THREAD_ID })
    const first = { ...counts }
    await receipts.read({ projectId: ASSISTANT_SPACE_ID, threadId: THREAD_ID })
    expect(counts).toEqual(first)
  })

  it('uses no synchronous child process anywhere in the receipt modules', async () => {
    const directory = join(process.cwd(), 'src', 'main', 'chat', 'run-receipt')
    const files = await readdir(directory)
    const sources = await Promise.all(
      files
        .filter((file) => file.endsWith('.ts'))
        .map((file) => readFile(join(directory, file), 'utf8'))
    )
    sources.push(await readFile(join(directory, '..', 'run-receipt-service.ts'), 'utf8'))
    for (const source of sources) {
      expect(source).not.toMatch(/execFileSync|spawnSync|execSync/u)
    }
  })
})

describe('git range parsing', () => {
  it('reads name-status records, including a rename', () => {
    expect(parseNameStatus('M\0src/a.ts\0A\0src/b.ts\0R100\0src/c.ts\0src/d.ts\0')).toEqual([
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/b.ts', status: 'added' },
      { path: 'src/d.ts', oldPath: 'src/c.ts', status: 'renamed' }
    ])
  })

  it('reads numstat records, including a binary file and a rename', () => {
    expect(parseNumstat('4\t2\tsrc/a.ts\0-\t-\tsrc/logo.png\0')).toEqual([
      { path: 'src/a.ts', additions: 4, deletions: 2, binary: false },
      { path: 'src/logo.png', additions: 0, deletions: 0, binary: true }
    ])
  })
})

describe('git range read against a real repository', () => {
  const directories: string[] = []
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
    )
  })

  it('reports one file with its real line counts, in one read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cio-receipt-'))
    directories.push(directory)
    const { execFile } = await import('node:child_process')
    const run = (args: string[]): Promise<void> =>
      new Promise((resolve, reject) => {
        execFile('git', args, { cwd: directory }, (error) => (error ? reject(error) : resolve()))
      })
    await run(['init', '-q'])
    await run(['config', 'user.email', 'test@example.com'])
    await run(['config', 'user.name', 'Test'])
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(join(directory, 'src'), { recursive: true })
    await writeFile(join(directory, 'src', 'a.ts'), 'one\n')
    await run(['add', '.'])
    await run(['commit', '-qm', 'base'])
    await writeFile(join(directory, 'src', 'a.ts'), 'one\ntwo\nthree\n')
    await run(['commit', '-qam', 'change'])

    const git = new GitService()
    const head = await git.log(directory, 1)
    expect(head[0]?.message).toBe('change')
    const files = await git.rangeFiles(directory, `${head[0]?.hash}~1`, head[0]?.hash)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'src/a.ts', status: 'modified', additions: 2 })
    expect(existsSync(join(directory, 'src', 'a.ts'))).toBe(true)
  })
})
