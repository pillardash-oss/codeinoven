import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  ProjectEnvService,
  type ProjectEnvSecretsPort
} from '../../src/main/secrets/project-env-service'
import { ProjectEnvStore } from '../../src/main/secrets/project-env-store'
import { StorageEngine } from '../../src/main/storage/storage-engine'
import { parseProjectEnvFile, projectEnvFileText } from '../../src/lib/project-env'

/** Windows has no POSIX mode bits: chmod only toggles the read-only flag there. */
async function expectOwnerOnly(path: string): Promise<void> {
  if (process.platform === 'win32') return
  expect((await stat(path)).mode & 0o777).toBe(0o600)
}

/** An in-memory stand-in for the vault: refs and values, nothing encrypted. */
function fakeSecrets(): ProjectEnvSecretsPort & { values: Map<string, string> } {
  const values = new Map<string, string>()
  let counter = 0
  return {
    values,
    async save(value: string, existingRef?: string): Promise<string> {
      const ref = existingRef ?? `secret_${++counter}`
      values.set(ref, value)
      return ref
    },
    async resolve(ref: string): Promise<string> {
      const value = values.get(ref)
      if (value === undefined) throw new Error('Credential not found')
      return value
    },
    async exists(ref: string): Promise<boolean> {
      return values.has(ref)
    },
    async remove(ref: string): Promise<void> {
      values.delete(ref)
    }
  }
}

let root: string
let projectRoot: string
let storage: StorageEngine
let secrets: ReturnType<typeof fakeSecrets>
let service: ProjectEnvService

const PROJECT_ID = 'proj-1'
const THREAD_ID = 'thread-1'

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codeinoven-project-env-'))
  projectRoot = join(root, 'project')
  await mkdir(join(projectRoot, 'packages', 'api'), { recursive: true })
  storage = new StorageEngine(join(root, 'config'))
  secrets = fakeSecrets()
  service = new ProjectEnvService({
    store: new ProjectEnvStore(storage),
    secrets,
    resolveProjectPath: async () => projectRoot
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('ProjectEnvService resolution', () => {
  it('resolves a root key for a process started at the project root', async () => {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })
    await service.setProjectEnvValue({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      name: 'API_URL',
      value: 'https://api.example.com'
    })

    const launch = await service.environmentForLaunch({ projectId: PROJECT_ID, cwd: projectRoot })

    expect(launch.environment).toEqual({ API_URL: 'https://api.example.com' })
    expect(launch.preview.entries).toEqual([
      { name: 'API_URL', group: '', fileName: '.env', scope: 'project' }
    ])
  })

  it('lets a deeper directory group and a later run mode override, and a thread win over all', async () => {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env.local' })
    await service.createProjectEnvFile({
      projectId: PROJECT_ID,
      group: 'packages/api',
      fileName: '.env'
    })

    await service.setProjectEnvValue({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      name: 'DATABASE_URL',
      value: 'postgres://root'
    })
    await service.setProjectEnvValue({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env.local',
      name: 'DATABASE_URL',
      value: 'postgres://local'
    })
    await service.setProjectEnvValue({
      projectId: PROJECT_ID,
      group: 'packages/api',
      fileName: '.env',
      name: 'DATABASE_URL',
      value: 'postgres://api'
    })
    await service.setThreadEnvValue({
      threadId: THREAD_ID,
      name: 'DATABASE_URL',
      value: 'postgres://thread'
    })

    const atRoot = await service.environmentForLaunch({ projectId: PROJECT_ID, cwd: projectRoot })
    expect(atRoot.environment['DATABASE_URL']).toBe('postgres://local')

    const inPackage = await service.environmentForLaunch({
      projectId: PROJECT_ID,
      cwd: join(projectRoot, 'packages', 'api')
    })
    expect(inPackage.environment['DATABASE_URL']).toBe('postgres://api')
    expect(inPackage.preview.entries[0]).toMatchObject({ group: 'packages/api', fileName: '.env' })

    const inThread = await service.environmentForLaunch({
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
      cwd: join(projectRoot, 'packages', 'api')
    })
    expect(inThread.environment['DATABASE_URL']).toBe('postgres://thread')
    expect(inThread.preview.entries[0]).toMatchObject({ scope: 'thread' })
  })

  it('matches a package group from a worktree cwd when the caller names the directory', async () => {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })
    await service.createProjectEnvFile({
      projectId: PROJECT_ID,
      group: 'packages/api',
      fileName: '.env'
    })
    await service.setProjectEnvValue({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      name: 'API_URL',
      value: 'root'
    })
    await service.setProjectEnvValue({
      projectId: PROJECT_ID,
      group: 'packages/api',
      fileName: '.env',
      name: 'API_URL',
      value: 'package'
    })

    // A managed worktree lives outside the project directory, so a cwd-relative
    // guess cannot see the package group; the named directory can.
    const launch = await service.environmentForLaunch({
      projectId: PROJECT_ID,
      cwd: join(root, 'config', 'projects', PROJECT_ID, 'scope', 'feature'),
      directory: 'packages/api'
    })

    expect(launch.environment['API_URL']).toBe('package')
  })

  it('refuses a name the OS or the app owns', async () => {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })

    await expect(
      service.setProjectEnvValue({
        projectId: PROJECT_ID,
        group: '',
        fileName: '.env',
        name: 'PATH',
        value: '/tmp/bin'
      })
    ).rejects.toThrow(/reserved/u)

    await expect(
      service.setProjectEnvValue({
        projectId: PROJECT_ID,
        group: '',
        fileName: '.env',
        name: 'CIO_SOMETHING',
        value: 'x'
      })
    ).rejects.toThrow(/reserved by the app/u)
  })

  it('reports a name whose value is gone instead of failing the launch', async () => {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })
    await service.setProjectEnvValue({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      name: 'STRIPE_KEY',
      value: 'sk_test'
    })
    secrets.values.clear()

    const launch = await service.environmentForLaunch({ projectId: PROJECT_ID, cwd: projectRoot })

    expect(launch.environment).toEqual({})
    expect(launch.preview.skipped).toEqual([
      { name: 'STRIPE_KEY', reason: expect.stringContaining('no longer stored') }
    ])
  })
})

describe('ProjectEnvService typed body', () => {
  it('stores values, keeps empty lines that have a value, and removes what is gone', async () => {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })

    const first = await service.applyEnvText({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      text: '# app\nDATABASE_URL=postgres://one\nPORT=3000\n'
    })
    expect(first.stored).toEqual(['DATABASE_URL', 'PORT'])
    expect(first.kept).toEqual([])

    // PORT keeps its value because its line carries none; MAIL_KEY is new and has
    // no value yet, so it is reported instead of stored; DATABASE_URL is rewritten.
    const second = await service.applyEnvText({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      text: 'DATABASE_URL=postgres://two\nPORT=\nMAIL_KEY=\n'
    })

    expect(second.stored).toEqual(['DATABASE_URL'])
    expect(second.kept).toEqual(['PORT'])
    expect(second.removed).toEqual([])
    expect(second.skipped).toEqual([
      { line: 3, reason: 'MAIL_KEY has no value yet, so nothing was stored for it' }
    ])

    const launch = await service.environmentForLaunch({ projectId: PROJECT_ID, cwd: projectRoot })
    expect(launch.environment).toEqual({ DATABASE_URL: 'postgres://two', PORT: '3000' })

    const third = await service.applyEnvText({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      text: 'PORT=3000\n'
    })
    expect(third.removed).toEqual(['DATABASE_URL'])
    expect(secrets.values.size).toBe(1)
  })

  it('creates the file from a typed body, and refuses a name it may not set', async () => {
    const created = await service.applyEnvText({
      projectId: PROJECT_ID,
      group: 'packages/api',
      fileName: '.env.local',
      text: 'API_URL=http://localhost:3001\n'
    })
    expect(created.files).toEqual([
      expect.objectContaining({ group: 'packages/api', fileName: '.env.local' })
    ])

    const refused = await service.applyEnvText({
      projectId: PROJECT_ID,
      group: 'packages/api',
      fileName: '.env.local',
      text: 'API_URL=http://localhost:3001\nPATH=/tmp\n'
    })
    expect(refused.stored).toEqual(['API_URL'])
    expect(refused.skipped[0]?.line).toBe(2)
  })
})

describe('ProjectEnvService values for the editor', () => {
  it('hands the stored values back, in name order', async () => {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })
    await service.applyEnvText({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      text: 'DATABASE_URL=postgres://demo\nQUOTED="a b#c"\nMULTI="line one\\nline two"\n'
    })

    const values = await service.readEnvValues({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env'
    })

    expect(values.entries).toContainEqual({ name: 'MULTI', value: 'line one\nline two' })
    expect(values.entries.filter((entry) => entry.name !== 'MULTI')).toEqual([
      { name: 'DATABASE_URL', value: 'postgres://demo' },
      { name: 'QUOTED', value: 'a b#c' }
    ])
  })

  it('does not re-encrypt a name the caller says it left untouched', async () => {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })
    let saves = 0
    const counting: ProjectEnvSecretsPort = {
      ...secrets,
      async save(value: string, existingRef?: string): Promise<string> {
        saves += 1
        return secrets.save(value, existingRef)
      }
    }
    const countingService = new ProjectEnvService({
      store: new ProjectEnvStore(storage),
      secrets: counting,
      resolveProjectPath: async () => projectRoot
    })
    await countingService.applyEnvText({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      text: 'PORT=3000\n'
    })
    expect(saves).toBe(1)

    // Opening the file and saving it again keeps the value exactly as it was.
    const kept = await countingService.applyEnvText({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      text: 'PORT=3000\n',
      keep: ['PORT']
    })
    expect(saves).toBe(1)
    expect(kept.kept).toEqual(['PORT'])
    expect(secrets.values.size).toBe(1)
  })
})

describe('ProjectEnvService writing the file into the project', () => {
  it('writes references, keeps the previous content, and is idempotent', async () => {
    await service.createProjectEnvFile({
      projectId: PROJECT_ID,
      group: 'packages/api',
      fileName: '.env'
    })
    await service.setProjectEnvValue({
      projectId: PROJECT_ID,
      group: 'packages/api',
      fileName: '.env',
      name: 'DATABASE_URL',
      value: 'postgres://inside'
    })
    const target = join(projectRoot, 'packages', 'api', '.env')
    await writeFile(target, 'DATABASE_URL=postgres://old\n', 'utf8')

    const written = await service.writeEnvFileToProject({
      projectId: PROJECT_ID,
      group: 'packages/api',
      fileName: '.env'
    })

    expect(written).toEqual({
      path: 'packages/api/.env',
      changed: true,
      backupPath: '.cio/secrets/packages/api/.env'
    })
    const content = await readFile(target, 'utf8')
    expect(content).toMatch(/^DATABASE_URL=cio:\/\/secret_/mu)
    expect(content).not.toContain('postgres://old')
    const backupTarget = join(projectRoot, '.cio', 'secrets', 'packages', 'api', '.env')
    expect(await readFile(backupTarget, 'utf8')).toBe('DATABASE_URL=postgres://old\n')
    await expectOwnerOnly(backupTarget)
    await expectOwnerOnly(target)

    expect(await readFile(target, 'utf8')).toBe(content)
    const again = await service.writeEnvFileToProject({
      projectId: PROJECT_ID,
      group: 'packages/api',
      fileName: '.env'
    })
    expect(again.changed).toBe(false)
    expect(again.backupPath).toBeUndefined()
  })

  it('refuses to write a file with no keys', async () => {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })
    await expect(
      service.writeEnvFileToProject({ projectId: PROJECT_ID, group: '', fileName: '.env' })
    ).rejects.toThrow(/Add a key/u)
  })
})

describe('ProjectEnvService keeping the user lines', () => {
  it('stores the comments around a key and gives them back with the values', async () => {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })
    await service.applyEnvText({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      text: ['# deployment', 'PORT=3000', '', '# rotated weekly', 'DEBUG=1', ''].join('\n')
    })

    const [file] = await service.listProjectEnv(PROJECT_ID)
    expect(file?.layout).toEqual([
      { kind: 'text', text: '# deployment' },
      { kind: 'key', name: 'PORT' },
      { kind: 'text', text: '' },
      { kind: 'text', text: '# rotated weekly' },
      { kind: 'key', name: 'DEBUG' },
      { kind: 'text', text: '' }
    ])
    // The manifest holds the shape of the file, never a value from it.
    expect(JSON.stringify(file?.layout)).not.toContain('3000')

    const values = await service.readEnvValues({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env'
    })
    const byName = new Map(values.entries.map((entry) => [entry.name, entry.value]))
    expect(projectEnvFileText({ layout: file?.layout, entries: values.entries }, byName)).toBe(
      ['# deployment', 'PORT=3000', '', '# rotated weekly', 'DEBUG=1', ''].join('\n')
    )
  })

  it('writes no comment into the project file', async () => {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })
    await service.applyEnvText({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      text: ['# deployment note', 'PORT=3000', ''].join('\n')
    })

    const written = await service.writeEnvFileToProject({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env'
    })
    expect(written.changed).toBe(true)
    const content = await readFile(join(projectRoot, '.env'), 'utf8')
    expect(content).not.toContain('deployment note')
    expect(content).toMatch(/^PORT=cio:\/\/secret_/mu)
  })
})

describe('ProjectEnvService import', () => {
  it('previews without writing, then rewrites the file and keeps a private backup', async () => {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })
    const original = '# local only\nDATABASE_URL=postgres://secret\nPORT=3000\n'
    await writeFile(join(projectRoot, '.env'), original, 'utf8')

    const preview = await service.importProjectEnv({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      path: '.env',
      apply: false
    })

    expect(preview.preview.names).toEqual(['DATABASE_URL', 'PORT'])
    expect(preview.preview.created).toEqual(['DATABASE_URL', 'PORT'])
    expect(await readFile(join(projectRoot, '.env'), 'utf8')).toBe(original)
    expect(secrets.values.size).toBe(0)

    const applied = await service.importProjectEnv({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      path: '.env',
      apply: true
    })

    const rewritten = await readFile(join(projectRoot, '.env'), 'utf8')
    expect(rewritten).toContain('# local only')
    expect(rewritten).toMatch(/^DATABASE_URL=cio:\/\/secret_/mu)
    expect(rewritten).not.toContain('postgres://secret')
    expect(applied.backupPath).toBe('.cio/secrets/.env')

    const backup = await readFile(join(projectRoot, '.cio', 'secrets', '.env'), 'utf8')
    expect(backup).toBe(original)
    await expectOwnerOnly(join(projectRoot, '.cio', 'secrets', '.env'))
    await expectOwnerOnly(join(projectRoot, '.env'))

    const launch = await service.environmentForLaunch({ projectId: PROJECT_ID, cwd: projectRoot })
    expect(launch.environment).toEqual({ DATABASE_URL: 'postgres://secret', PORT: '3000' })
  })

  it('forgets a key and its value together', async () => {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })
    await service.setProjectEnvValue({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      name: 'MAIL_KEY',
      value: 'mail'
    })
    expect(secrets.values.size).toBe(1)

    await service.removeProjectEnvEntry({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      name: 'MAIL_KEY'
    })

    expect(secrets.values.size).toBe(0)
    expect(await service.listProjectEnv(PROJECT_ID)).toEqual([
      { group: '', fileName: '.env', entries: [], updatedAt: expect.any(Number) }
    ])
  })
})

describe('ProjectEnvService turned-off keys', () => {
  it('switches a key off and on again without losing its value', async () => {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })
    await service.applyEnvText({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      text: 'PORT=3000\n'
    })

    const off = await service.setProjectEnvEntryDisabled({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      name: 'PORT',
      disabled: true
    })
    expect(off[0]?.entries[0]).toMatchObject({ name: 'PORT', disabled: true })
    expect(secrets.values.size).toBe(1)

    const launch = await service.environmentForLaunch({ projectId: PROJECT_ID, cwd: projectRoot })
    expect(launch.environment).toEqual({})
    expect(launch.preview.entries).toEqual([])
    expect(launch.preview.disabled).toEqual([
      { name: 'PORT', group: '', fileName: '.env', scope: 'project' }
    ])

    const on = await service.setProjectEnvEntryDisabled({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      name: 'PORT',
      disabled: false
    })
    expect(on[0]?.entries[0]?.disabled).toBeUndefined()
    const again = await service.environmentForLaunch({ projectId: PROJECT_ID, cwd: projectRoot })
    expect(again.environment).toEqual({ PORT: '3000' })
    expect(again.preview.disabled).toEqual([])
  })

  it('reads a commented key as turned off while leaving other comments alone', async () => {
    const result = await service.applyEnvText({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      text: '# just a note\n#cio-cmt FEATURE_FLAG=on\nPORT=3000\n'
    })

    expect(result.stored).toEqual(['FEATURE_FLAG', 'PORT'])
    const files = await service.listProjectEnv(PROJECT_ID)
    expect(files[0]?.entries.map((entry) => [entry.name, entry.disabled])).toEqual([
      ['FEATURE_FLAG', true],
      ['PORT', undefined]
    ])

    const launch = await service.environmentForLaunch({ projectId: PROJECT_ID, cwd: projectRoot })
    expect(launch.environment).toEqual({ PORT: '3000' })
    expect(launch.preview.disabled.map((entry) => entry.name)).toEqual(['FEATURE_FLAG'])
  })

  it('switches an existing key off from a commented line that carries no value', async () => {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })
    await service.applyEnvText({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      text: 'PORT=3000\n'
    })

    const result = await service.applyEnvText({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      text: '#cio-cmt PORT=\n',
      keep: []
    })

    expect(result.kept).toEqual(['PORT'])
    expect(secrets.values.size).toBe(1)
    const files = await service.listProjectEnv(PROJECT_ID)
    expect(files[0]?.entries[0]).toMatchObject({ name: 'PORT', disabled: true })
  })

  it('writes a turned-off key as a comment and reads the file back the same way', async () => {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })
    await service.applyEnvText({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      text: 'PORT=3000\nFEATURE_FLAG=on\n'
    })
    await service.setProjectEnvEntryDisabled({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      name: 'FEATURE_FLAG',
      disabled: true
    })

    const written = await service.writeEnvFileToProject({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env'
    })
    expect(written.changed).toBe(true)

    const content = await readFile(join(projectRoot, '.env'), 'utf8')
    expect(content).toMatch(/^PORT=cio:\/\/secret_/mu)
    expect(content).toMatch(/^#cio-cmt FEATURE_FLAG=cio:\/\/secret_/mu)
    const plan = parseProjectEnvFile(content)
    expect(plan.flatMap((line) => (line.kind === 'assignment' ? [line] : []))).toEqual([
      expect.objectContaining({ name: 'PORT', disabled: false }),
      expect.objectContaining({ name: 'FEATURE_FLAG', disabled: true })
    ])
  })

  it('imports a commented key as turned off', async () => {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })
    await writeFile(join(projectRoot, '.env'), '#cio-cmt PORT=3000\n', 'utf8')

    const applied = await service.importProjectEnv({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      path: '.env',
      apply: true
    })

    expect(applied.files[0]?.entries[0]).toMatchObject({ name: 'PORT', disabled: true })
    expect(applied.preview.rewritten).toMatch(/^#cio-cmt PORT=cio:\/\/secret_/mu)
  })
})

describe('ProjectEnvService creating a file', () => {
  it('refuses a second file at a path that already has one', async () => {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })

    await expect(
      service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })
    ).rejects.toThrow(/already has \.env/u)

    const files = await service.listProjectEnv(PROJECT_ID)
    expect(files.map((file) => file.fileName)).toEqual(['.env'])
  })

  it('names the next free file in the refusal instead of colliding', async () => {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env.local' })

    await expect(
      service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env.local' })
    ).rejects.toThrow(/use \.env\.development/u)
  })

  it('treats a name that differs only in case as the same file on disk', async () => {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })

    await expect(
      service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.ENV' })
    ).rejects.toThrow(/already has \.ENV/u)

    // A body typed into the differently-cased name lands in the one file, not a second one.
    await service.applyEnvText({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.ENV',
      text: 'PORT=3000\n'
    })

    const files = await service.listProjectEnv(PROJECT_ID)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ fileName: '.env' })
    expect(files[0]?.entries.map((entry) => entry.name)).toEqual(['PORT'])
  })

  it('reads a manifest that named one path twice as a single file', async () => {
    await storage.write('project-env/proj-1.json', {
      version: 1,
      projectId: PROJECT_ID,
      files: [
        {
          group: '',
          fileName: '.env',
          updatedAt: 1,
          entries: [{ name: 'PORT', secretRef: 'secret_1', updatedAt: 1 }]
        },
        {
          group: '',
          fileName: '.ENV',
          updatedAt: 2,
          entries: [{ name: 'API_URL', secretRef: 'secret_2', updatedAt: 2 }]
        }
      ]
    })

    const files = await service.listProjectEnv(PROJECT_ID)
    expect(files).toHaveLength(1)
    expect(files[0]?.fileName).toBe('.env')
    expect(files[0]?.entries.map((entry) => entry.name)).toEqual(['API_URL', 'PORT'])
  })
})

describe('ProjectEnvService inject rule', () => {
  it('stores the script lines, dropping blanks, comments and trailing spaces', async () => {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })

    const files = await service.setProjectEnvInjectRule({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      text: '  bunx convex deploy  \n\n# only on deploy\nbun run deploy\ncd packages/convex-backend bun run deploy\n'
    })

    expect(files[0]?.injectRule).toEqual([
      'bunx convex deploy',
      'bun run deploy',
      'cd packages/convex-backend bun run deploy'
    ])

    // A rule is manifest state, so it reads back from disk with no value in sight.
    const reopened = await service.listProjectEnv(PROJECT_ID)
    expect(reopened[0]?.injectRule).toEqual([
      'bunx convex deploy',
      'bun run deploy',
      'cd packages/convex-backend bun run deploy'
    ])
  })

  it('clears the limit when the rule is emptied, leaving the keys alone', async () => {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })
    await service.setProjectEnvValue({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      name: 'API_URL',
      value: 'https://api.example.com'
    })
    await service.setProjectEnvInjectRule({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      text: 'bun run deploy'
    })

    const files = await service.setProjectEnvInjectRule({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      text: '\n  \n'
    })

    expect(files[0]?.injectRule).toBeUndefined()
    expect(files[0]?.entries.map((entry) => entry.name)).toEqual(['API_URL'])

    // An unlimited file still injects everything, which is what it did before.
    const launch = await service.environmentForLaunch({ projectId: PROJECT_ID, cwd: projectRoot })
    expect(launch.environment).toEqual({ API_URL: 'https://api.example.com' })
  })

  it('refuses a file that does not exist instead of inventing one', async () => {
    await expect(
      service.setProjectEnvInjectRule({
        projectId: PROJECT_ID,
        group: '',
        fileName: '.env',
        text: 'bun run deploy'
      })
    ).rejects.toThrow(/no longer exists/u)
  })
})

describe('ProjectEnvService inject rule enforcement', () => {
  async function seed(): Promise<void> {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })
    await service.setProjectEnvValue({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      name: 'ROOT_URL',
      value: 'https://root.example.com'
    })
    await service.createProjectEnvFile({
      projectId: PROJECT_ID,
      group: 'packages/convex-backend',
      fileName: '.env'
    })
    await service.setProjectEnvValue({
      projectId: PROJECT_ID,
      group: 'packages/convex-backend',
      fileName: '.env',
      name: 'DEPLOY_KEY',
      value: 'sk-deploy'
    })
    await service.setProjectEnvInjectRule({
      projectId: PROJECT_ID,
      group: 'packages/convex-backend',
      fileName: '.env',
      text: 'cd packages/convex-backend bun run deploy'
    })
  }

  it('injects a ruled file into the script the rule names', async () => {
    await seed()

    const launch = await service.environmentForLaunch({
      projectId: PROJECT_ID,
      cwd: projectRoot,
      directory: 'packages/convex-backend',
      command: 'cd packages/convex-backend && bun run deploy'
    })

    expect(launch.environment).toMatchObject({
      DEPLOY_KEY: 'sk-deploy',
      ROOT_URL: 'https://root.example.com'
    })
    expect(launch.preview.skipped).toEqual([])
  })

  it('withholds a ruled file from any other script, and says why', async () => {
    await seed()

    const launch = await service.environmentForLaunch({
      projectId: PROJECT_ID,
      cwd: projectRoot,
      directory: 'packages/convex-backend',
      command: 'bun run test'
    })

    expect(launch.environment).toEqual({ ROOT_URL: 'https://root.example.com' })
    expect(launch.preview.skipped).toEqual([
      {
        name: 'DEPLOY_KEY',
        reason: expect.stringMatching(
          /only injected into the scripts packages\/convex-backend\/\.env names/iu
        )
      }
    ])
  })

  it('does not substitute a shallower value for a withheld name', async () => {
    await seed()
    await service.setProjectEnvValue({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      name: 'DEPLOY_KEY',
      value: 'from-the-root'
    })

    const launch = await service.environmentForLaunch({
      projectId: PROJECT_ID,
      cwd: projectRoot,
      directory: 'packages/convex-backend',
      command: 'bun run test'
    })

    expect(launch.environment).not.toHaveProperty('DEPLOY_KEY')
  })

  it('applies no rule to a launch whose command is not known yet', async () => {
    await seed()

    const launch = await service.environmentForLaunch({
      projectId: PROJECT_ID,
      cwd: projectRoot,
      directory: 'packages/convex-backend'
    })

    expect(launch.environment).toMatchObject({ DEPLOY_KEY: 'sk-deploy' })
  })

  it('matches any of several scripts, and a rule that names no directory', async () => {
    await service.createProjectEnvFile({ projectId: PROJECT_ID, group: '', fileName: '.env' })
    await service.setProjectEnvValue({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      name: 'REGISTRY_TOKEN',
      value: 'tok'
    })
    await service.setProjectEnvInjectRule({
      projectId: PROJECT_ID,
      group: '',
      fileName: '.env',
      text: 'bunx convex deploy\nbun run deploy'
    })

    for (const command of ['bunx convex deploy', 'bun run deploy']) {
      const launch = await service.environmentForLaunch({
        projectId: PROJECT_ID,
        cwd: projectRoot,
        command
      })
      expect(launch.environment).toEqual({ REGISTRY_TOKEN: 'tok' })
    }

    const other = await service.environmentForLaunch({
      projectId: PROJECT_ID,
      cwd: projectRoot,
      command: 'bun run dev'
    })
    expect(other.environment).toEqual({})
  })
})
