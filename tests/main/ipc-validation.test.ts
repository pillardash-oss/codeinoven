import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  isTrustedOrigin,
  originOfUrl,
  PrivilegedIpcValidator,
  validateBoolean,
  validateBoundedInteger,
  validateBoundedString,
  validateBranchName,
  validateChecklistItemStatus,
  validateCommitMessage,
  validateCreateProjectInput,
  validateCreateThreadInput,
  validateEntityId,
  validateGitPathArray,
  validateGitRelativePath,
  validateHistoryRole,
  validateMergeMethod,
  validateMergeTarget,
  validatePrCreateInput,
  validatePrNumber,
  validatePushOptions,
  validateRemoteName,
  validateRemoteUrl,
  validateThreadSettings,
  validateThreadStatus
} from '../../src/main/ipc-validation'

const validSettings = {
  harnessId: 'opencode',
  providerId: 'anthropic',
  modelId: 'anthropic/claude-sonnet-4',
  thinkingLevel: 'high',
  permissionLevel: 'auto_review',
  engineeringMode: true,
  assignmentMode: false,
  loopMode: false
}

describe('IPC primitive validation', () => {
  it('accepts safe entity IDs and rejects traversal or separators', () => {
    expect(validateEntityId(' codeinoven-inbox ')).toBe('codeinoven-inbox')

    for (const value of ['.', '..', '../secret', 'project/child', 'project\\child', '']) {
      expect(() => validateEntityId(value)).toThrow(TypeError)
    }
  })

  it('validates booleans without coercion', () => {
    expect(validateBoolean(false)).toBe(false)
    expect(() => validateBoolean(0)).toThrow(TypeError)
    expect(() => validateBoolean('true')).toThrow(TypeError)
  })

  it('validates bounded safe integers', () => {
    expect(validateBoundedInteger(10, 'Limit', 1, 10)).toBe(10)

    for (const value of [0, 11, 1.5, Number.MAX_VALUE, '2']) {
      expect(() => validateBoundedInteger(value, 'Limit', 1, 10)).toThrow(TypeError)
    }
  })

  it('trims bounded strings and rejects null bytes', () => {
    expect(validateBoundedString('  CodeInOven  ', 'Name', 1, 20)).toBe('CodeInOven')
    expect(() => validateBoundedString('   ', 'Name', 1, 20)).toThrow(TypeError)
    expect(() => validateBoundedString('bad\0value', 'Name', 1, 20)).toThrow(TypeError)
  })
})

describe('IPC enum validation', () => {
  it('validates every thread status', () => {
    const statuses = [
      'created',
      'planning',
      'awaiting_approval',
      'executing',
      'interrupted',
      'completed',
      'failed'
    ]

    for (const status of statuses) {
      expect(validateThreadStatus(status)).toBe(status)
    }
    expect(() => validateThreadStatus('running')).toThrow(TypeError)
  })

  it('validates history roles and checklist statuses', () => {
    expect(validateHistoryRole('assistant')).toBe('assistant')
    expect(validateChecklistItemStatus('in_progress')).toBe('in_progress')
    expect(() => validateHistoryRole('developer')).toThrow(TypeError)
    expect(() => validateChecklistItemStatus('done')).toThrow(TypeError)
  })
})

describe('IPC structured input validation', () => {
  it('sanitizes complete thread settings', () => {
    expect(
      validateThreadSettings({
        ...validSettings,
        harnessId: ' opencode ',
        modelId: ' anthropic/claude-sonnet-4 '
      })
    ).toEqual(validSettings)
  })

  it('rejects invalid, incomplete, and extended thread settings', () => {
    expect(() => validateThreadSettings({ ...validSettings, engineeringMode: 'yes' })).toThrow(
      TypeError
    )
    expect(() => validateThreadSettings({ ...validSettings, permissionLevel: 'all' })).toThrow(
      TypeError
    )
    expect(() => validateThreadSettings({ ...validSettings, extra: true })).toThrow(
      'Unsupported thread settings field'
    )
    expect(() =>
      validateThreadSettings({
        harnessId: 'opencode',
        providerId: 'anthropic'
      })
    ).toThrow(TypeError)
  })

  it('sanitizes create-project input and preserves valid options', () => {
    expect(
      validateCreateProjectInput({
        name: ' CodeInOven ',
        path: ' /projects/codeinoven ',
        source: 'ssh',
        host: ' dev.example.test ',
        providerId: 'opencode',
        workflowId: 'engineering',
        threadLimit: 80,
        hidden: false,
        changeTrackingMode: 'manual'
      })
    ).toEqual({
      name: 'CodeInOven',
      path: '/projects/codeinoven',
      source: 'ssh',
      host: 'dev.example.test',
      providerId: 'opencode',
      workflowId: 'engineering',
      threadLimit: 80,
      hidden: false,
      changeTrackingMode: 'manual'
    })
  })

  it('rejects unknown or invalid create-project fields', () => {
    expect(() =>
      validateCreateProjectInput({
        name: 'CodeInOven',
        path: '/projects/codeinoven',
        owner: 'user'
      })
    ).toThrow('Unsupported create project field')
    expect(() =>
      validateCreateProjectInput({
        name: 'CodeInOven',
        path: '/projects/codeinoven',
        threadLimit: 1001
      })
    ).toThrow(TypeError)
    expect(() =>
      validateCreateProjectInput({
        name: 'CodeInOven',
        path: '/projects/codeinoven',
        source: 'remote'
      })
    ).toThrow(TypeError)
  })

  it('sanitizes create-thread input including nested settings', () => {
    expect(
      validateCreateThreadInput({
        projectId: ' project-1 ',
        providerId: 'opencode',
        title: ' Implement IPC validation ',
        workingDirectory: ' /projects/codeinoven ',
        settings: validSettings
      })
    ).toEqual({
      projectId: 'project-1',
      providerId: 'opencode',
      title: 'Implement IPC validation',
      workingDirectory: '/projects/codeinoven',
      settings: validSettings
    })
  })

  it('rejects unknown or unsafe create-thread fields', () => {
    expect(() =>
      validateCreateThreadInput({
        projectId: '../project',
        providerId: 'opencode',
        title: 'Unsafe'
      })
    ).toThrow(TypeError)
    expect(() =>
      validateCreateThreadInput({
        projectId: 'project-1',
        providerId: 'opencode',
        title: 'Unknown',
        status: 'created'
      })
    ).toThrow('Unsupported create thread field')
  })
})

describe('IPC git validation', () => {
  it('validates project-relative git paths and rejects traversal', () => {
    expect(validateGitRelativePath(' src/lib/types.ts ')).toBe('src/lib/types.ts')
    expect(validateGitPathArray(['a.ts', 'b/c.ts'])).toEqual(['a.ts', 'b/c.ts'])
    expect(() => validateGitRelativePath('../outside.ts')).toThrow(TypeError)
    expect(() => validateGitRelativePath('a/../../outside.ts')).toThrow(TypeError)
    expect(() => validateGitPathArray(['ok.ts', ''])).toThrow(TypeError)
    expect(() => validateGitPathArray('a.ts')).toThrow(TypeError)
  })

  it('validates branch names and merge targets', () => {
    expect(validateBranchName('feature/thing-1')).toBe('feature/thing-1')
    expect(validateBranchName(' main ')).toBe('main')
    expect(validateMergeTarget('feature/x')).toBe('feature/x')
    expect(() => validateBranchName('../evil')).toThrow(TypeError)
    expect(() => validateBranchName('a b')).toThrow(TypeError)
    expect(() => validateBranchName('')).toThrow(TypeError)
  })

  it('validates commit messages without trimming or collapsing newlines', () => {
    expect(validateCommitMessage('  fix: thing  ')).toBe('  fix: thing  ')
    expect(validateCommitMessage('line one\r\nline two')).toBe('line one\nline two')
    expect(() => validateCommitMessage('')).toThrow(TypeError)
    expect(() => validateCommitMessage('bad\0value')).toThrow(TypeError)
  })

  it('validates remote names and scheme-constrained remote URLs', () => {
    expect(validateRemoteName('origin')).toBe('origin')
    expect(validateRemoteUrl('https://github.com/acme/app.git')).toBe(
      'https://github.com/acme/app.git'
    )
    expect(validateRemoteUrl('git@github.com:acme/app.git')).toBe('git@github.com:acme/app.git')
    expect(() => validateRemoteName('../origin')).toThrow(TypeError)
    expect(() => validateRemoteUrl('ftp://github.com/acme/app.git')).toThrow(TypeError)
    expect(() => validateRemoteUrl('https://github.com/acme/app.git\nx')).toThrow(TypeError)
  })

  it('validates merge methods and PR create inputs', () => {
    expect(validateMergeMethod('squash')).toBe('squash')
    expect(() => validateMergeMethod('rebase3')).toThrow(TypeError)
    expect(validatePrNumber(42)).toBe(42)
    expect(() => validatePrNumber(0)).toThrow(TypeError)
    expect(
      validatePrCreateInput({
        title: 'Add feature',
        body: 'Details',
        head: 'feature/x',
        base: 'main',
        draft: true
      })
    ).toEqual({
      title: 'Add feature',
      body: 'Details',
      head: 'feature/x',
      base: 'main',
      draft: true
    })
    expect(() =>
      validatePrCreateInput({ title: 'X', head: 'feature/x', base: 'main', owner: 'x' })
    ).toThrow('Unsupported pull request create input field')
  })

  it('validates push options', () => {
    expect(validatePushOptions({ setUpstream: true, remote: 'origin', branch: 'main' })).toEqual({
      setUpstream: true,
      remote: 'origin',
      branch: 'main'
    })
    expect(validatePushOptions({ setUpstream: false })).toEqual({ setUpstream: false })
    expect(() => validatePushOptions({ setUpstream: 'yes' })).toThrow(TypeError)
    expect(() => validatePushOptions({ setUpstream: true, force: true })).toThrow(TypeError)
  })
})

const TRUSTED_ORIGINS = new Set(['http://localhost:5173', 'file://'])

function createValidator(
  options: {
    scopes?: { projectRoots?: string[]; appArtifactRoots?: string[] }
    allowDevelopmentHttp?: boolean
    navigationTargets?: string[]
  } = {}
): PrivilegedIpcValidator {
  const hasScopes =
    (options.scopes?.projectRoots?.length ?? 0) > 0 ||
    (options.scopes?.appArtifactRoots?.length ?? 0) > 0
  return new PrivilegedIpcValidator({
    navigationTargets: options.navigationTargets,
    allowDevelopmentHttp: options.allowDevelopmentHttp,
    scopes: hasScopes
      ? {
          projectRoots: () => options.scopes?.projectRoots ?? [],
          appArtifactRoots: () => options.scopes?.appArtifactRoots ?? []
        }
      : undefined
  })
}

describe('privileged-IPC sender validation', () => {
  it('resolves trusted origins from URLs', () => {
    expect(originOfUrl('http://localhost:5173/index.html')).toBe('http://localhost:5173')
    expect(originOfUrl('file:///out/renderer/index.html')).toBe('file://')
    expect(originOfUrl('not a url')).toBeNull()
  })

  it('accepts the trusted main-frame renderer document', () => {
    const validator = createValidator({
      navigationTargets: ['http://localhost:5173', 'file:///app/out/renderer/index.html']
    })
    expect(validator.isTrustedSenderFrame({ url: 'http://localhost:5173/' })).toBe(true)
    expect(validator.isTrustedSenderFrame({ url: 'file:///app/out/renderer/index.html' })).toBe(
      true
    )
  })

  it('rejects subframes even when their document is trusted', () => {
    const validator = createValidator({ navigationTargets: ['http://localhost:5173'] })
    const main = { url: 'http://localhost:5173/' }
    expect(validator.isTrustedSenderFrame(main)).toBe(true)
    expect(
      validator.isTrustedSenderFrame({
        url: 'http://localhost:5173/',
        parent: { url: 'http://localhost:5173/' }
      })
    ).toBe(false)
  })

  it('rejects foreign, arbitrary same-origin, and packaged foreign file frames', () => {
    const validator = createValidator({
      navigationTargets: ['http://localhost:5173', 'file:///app/out/renderer/index.html']
    })
    for (const url of [
      'https://evil.example/phish',
      'http://localhost:5173/other.html',
      'http://localhost:9999/index.html',
      'appfile://project/project-1/README.md',
      'file:///etc/passwd'
    ]) {
      expect(validator.isTrustedSenderFrame({ url })).toBe(false)
    }
    expect(validator.isTrustedSenderFrame(null)).toBe(false)
    expect(validator.isTrustedSenderFrame(undefined)).toBe(false)
    expect(() =>
      validator.assertTrustedSender({ senderFrame: { url: 'https://evil.example' } })
    ).toThrow(/sender frame is not trusted/u)
  })

  it('isTrustedOrigin respects the explicit trusted set', () => {
    expect(isTrustedOrigin('http://localhost:5173/app', TRUSTED_ORIGINS)).toBe(true)
    expect(isTrustedOrigin('http://localhost:5174/app', TRUSTED_ORIGINS)).toBe(false)
  })
})

describe('privileged-IPC external URL validation', () => {
  it('permits parsed https: URLs', () => {
    const validator = createValidator()
    expect(validator.validateExternalUrl('https://example.com/path?q=1#frag')).toBe(
      'https://example.com/path?q=1#frag'
    )
    expect(validator.validateExternalUrl('https://github.com/acme/app')).toBe(
      'https://github.com/acme/app'
    )
  })

  it('permits intentionally supported development http: origins', () => {
    const validator = createValidator({ allowDevelopmentHttp: true })
    expect(validator.validateExternalUrl('http://localhost:5173')).toBe('http://localhost:5173/')
    expect(validator.validateExternalUrl('http://127.0.0.1:8877/api')).toBe(
      'http://127.0.0.1:8877/api'
    )
    expect(validator.validateExternalUrl('http://[::1]:5173/')).toBe('http://[::1]:5173/')
  })

  it('rejects plain http: URLs in production, including localhost', () => {
    const validator = createValidator()
    for (const url of ['http://example.com', 'http://localhost:5173', 'http://127.0.0.1:8877']) {
      expect(() => validator.validateExternalUrl(url)).toThrow(/only supported in development/iu)
    }
  })

  it('rejects non-localhost http: URLs even in development', () => {
    const validator = createValidator({ allowDevelopmentHttp: true })
    expect(() => validator.validateExternalUrl('http://example.com')).toThrow(
      /localhost development/iu
    )
    expect(() => validator.validateExternalUrl('http://192.168.1.10')).toThrow(TypeError)
  })

  it('rejects non-web schemes, credentials, control characters, and malformed input', () => {
    const validator = createValidator()
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>',
      'ftp://example.com/file',
      'appfile://project/project-1/README.md',
      'https://user:pass@example.com',
      'https://user@example.com',
      'https://example.com\npayload',
      'https://example.com\u0000payload',
      '',
      '   ',
      'not a url'
    ]) {
      expect(() => validator.validateExternalUrl(url)).toThrow(TypeError)
    }
    expect(() => validator.validateExternalUrl(42)).toThrow(TypeError)
  })
})

describe('privileged-IPC navigation validation', () => {
  it('permits only the exact renderer document in production', () => {
    const validator = createValidator({
      navigationTargets: ['file:///app/out/renderer/index.html']
    })
    expect(validator.isTrustedNavigation('file:///app/out/renderer/index.html')).toBe(true)
    expect(validator.isTrustedNavigation('file:///etc/passwd')).toBe(false)
    expect(validator.isTrustedNavigation('file:///app/out/renderer/other.html')).toBe(false)
    expect(validator.isTrustedNavigation('https://example.com')).toBe(false)
    expect(validator.isTrustedNavigation('http://localhost:5173')).toBe(false)
    expect(validator.isTrustedNavigation('')).toBe(false)
  })

  it('permits only the exact dev-server document in development, never arbitrary same-origin', () => {
    const validator = createValidator({
      allowDevelopmentHttp: true,
      navigationTargets: ['http://localhost:5173']
    })
    expect(validator.isTrustedNavigation('http://localhost:5173')).toBe(true)
    expect(validator.isTrustedNavigation('http://localhost:5173/')).toBe(true)
    expect(validator.isTrustedNavigation('http://localhost:5173/other.html')).toBe(false)
    expect(validator.isTrustedNavigation('http://localhost:5173/#/settings')).toBe(false)
    expect(validator.isTrustedNavigation('https://example.com')).toBe(false)
  })
})

describe('privileged-IPC scoped path validation', () => {
  let roots: string[] = []
  let configRoot = ''
  let artifactRoot = ''
  let createdRoot = ''

  async function setup(): Promise<PrivilegedIpcValidator> {
    const root = await mkdtemp(join(tmpdir(), 'cio-scope-'))
    createdRoot = root
    const project = join(root, 'project')
    const outside = join(root, 'outside')
    configRoot = join(root, 'config')
    artifactRoot = join(configRoot, 'projects', 'proj-1', 'spec-context', 'attachments')
    await mkdir(project, { recursive: true })
    await mkdir(outside, { recursive: true })
    await mkdir(artifactRoot, { recursive: true })
    await writeFile(join(project, 'readme.md'), 'hello')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    roots = [project]
    return new PrivilegedIpcValidator({
      navigationTargets: ['http://localhost:5173', 'file:///app/out/renderer/index.html'],
      scopes: { projectRoots: () => roots, appArtifactRoots: () => [artifactRoot] }
    })
  }

  afterEach(async () => {
    roots = []
    configRoot = ''
    artifactRoot = ''
    if (createdRoot) {
      await rm(createdRoot, { recursive: true, force: true })
      createdRoot = ''
    }
  })

  it('accepts paths inside registered project roots', async () => {
    const validator = await setup()
    const target = join(roots[0]!, 'readme.md')
    await expect(validator.resolveScopedPath(target)).resolves.toBe(await realpath(target))
  })

  it('accepts paths inside concrete app-owned artifact roots and file:// URL inputs', async () => {
    const validator = await setup()
    const target = join(artifactRoot, 'a1b2c3d4e5f60718293a4b5c')
    await writeFile(target, 'data')
    await expect(validator.resolveScopedPath(target)).resolves.toBe(await realpath(target))
    const asUrl = `file://${join(roots[0]!, 'readme.md')}`
    await expect(validator.resolveScopedPath(asUrl)).resolves.toBe(
      await realpath(join(roots[0]!, 'readme.md'))
    )
  })

  it('rejects app-secret files outside the concrete artifact roots', async () => {
    const validator = await setup()
    const configFile = join(configRoot, 'config.json')
    const vaultFile = join(configRoot, 'secrets', 'vault.json')
    await writeFile(configFile, '{"apiKey":"secret"}')
    await mkdir(join(configRoot, 'secrets'), { recursive: true })
    await writeFile(vaultFile, '{"enc":"secret"}')
    await expect(validator.resolveScopedPath(configFile)).rejects.toThrow(
      /approved project or user-selected scopes/iu
    )
    await expect(validator.resolveScopedPath(vaultFile)).rejects.toThrow(
      /approved project or user-selected scopes/iu
    )
  })

  it('accepts user-selected files and directories', async () => {
    const validator = await setup()
    const picked = await mkdtemp(join(tmpdir(), 'cio-picked-'))
    const file = join(picked, 'file.txt')
    const dir = join(picked, 'dir')
    await writeFile(file, 'x')
    await mkdir(dir)
    await validator.registerUserSelectedFile(file)
    await expect(validator.resolveScopedPath(file)).resolves.toBe(await realpath(file))
    await validator.registerUserSelectedRoot(dir)
    const inside = join(dir, 'nested.txt')
    await writeFile(inside, 'x')
    await expect(validator.resolveScopedPath(inside)).resolves.toBe(await realpath(inside))
    await rm(picked, { recursive: true, force: true })
  })

  it('does not widen a user-selected grant when the path is swapped for a symlink', async () => {
    const validator = await setup()
    const picked = await mkdtemp(join(tmpdir(), 'cio-swap-'))
    const selected = join(picked, 'selected.txt')
    const secret = join(picked, 'secret.txt')
    await writeFile(selected, 'original')
    await writeFile(secret, 'secret')
    await validator.registerUserSelectedFile(selected)
    await expect(validator.resolveScopedPath(selected)).resolves.toBe(await realpath(selected))

    await rm(selected)
    await symlink(secret, selected)
    await expect(validator.resolveScopedPath(selected)).rejects.toThrow(TypeError)
    await rm(picked, { recursive: true, force: true })
  })

  it('rejects paths outside the approved scopes', async () => {
    const validator = await setup()
    const outside = join(createdRoot, 'outside', 'secret.txt')
    await expect(validator.resolveScopedPath(outside)).rejects.toThrow(
      /approved project or user-selected scopes/iu
    )
  })

  it('rejects arbitrary relative paths, control characters, and symlink escapes', async () => {
    const validator = await setup()
    await expect(validator.resolveScopedPath('../etc/passwd')).rejects.toThrow(TypeError)
    await expect(validator.resolveScopedPath('/tmp/evil\u0000payload')).rejects.toThrow(TypeError)
    await expect(validator.resolveScopedPath(42)).rejects.toThrow(TypeError)

    const escape = join(tmpdir(), 'cio-scope-escape-link')
    const secret = join(tmpdir(), 'cio-scope-secret.txt')
    await writeFile(secret, 'secret')
    await symlink(secret, escape).catch(() => undefined)
    await expect(validator.resolveScopedPath(escape)).rejects.toThrow(TypeError)
  })

  it('rejects paths that do not resolve to an existing entry', async () => {
    const validator = await setup()
    await expect(validator.resolveScopedPath(join(roots[0]!, 'missing.md'))).rejects.toThrow(
      /does not resolve/iu
    )
  })
})
