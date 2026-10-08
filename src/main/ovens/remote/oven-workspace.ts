import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  link,
  unlink,
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  readlink,
  symlink,
  rename,
  rm
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { OvenFile, OvenWorkspaceRequest, OvenWorkspaceResult } from '../../../lib/ovens'

const CHUNK = 128 * 1024
const cloneLocks = new Map<string, Promise<void>>()

/** Permit only repository URLs that can be mapped to the dedicated GitHub key. */
export function normalizeGitHubSshUrl(value: string): string | null {
  const scp = value
    .trim()
    .match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u)
  if (scp) return `git@github.com:${scp[1]}/${scp[2]}.git`
  try {
    const parsed = new URL(value.trim())
    if (
      parsed.hostname.toLowerCase() !== 'github.com' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      return null
    const parts = parsed.pathname.split('/').filter(Boolean)
    if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_.-]+(?:\.git)?$/u.test(part)))
      return null
    const repo = parts[1].replace(/\.git$/u, '')
    return `git@github.com:${parts[0]}/${repo}.git`
  } catch {
    return null
  }
}

export function workspaceRoot(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\0\r\n]/u.test(value))
    throw new Error('Invalid workspace path.')
  const path = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
  if (!isAbsolute(path) || path === sep)
    throw new Error('Choose an absolute workspace directory, or ~/directory.')
  return resolve(path)
}

async function workspacePath(root: string, value: unknown, create = false): Promise<string> {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0') || isAbsolute(value))
    throw new Error('Choose a relative workspace path.')
  const path = resolve(root, value || '.')
  const inside = relative(root, path)
  if (inside === '..' || inside.startsWith(`..${sep}`))
    throw new Error('Path leaves the workspace.')
  const canonicalRoot = await realpath(root)
  let ancestor = create ? dirname(path) : path
  for (;;) {
    try {
      const canonical = await realpath(ancestor)
      const distance = relative(canonicalRoot, canonical)
      if (distance === '..' || distance.startsWith(`..${sep}`))
        throw new Error('A symbolic link leaves the workspace.')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (ancestor === root) throw error
      ancestor = dirname(ancestor)
    }
  }
  return path
}

async function fileInfo(root: string, path: string): Promise<OvenFile> {
  const info = await lstat(path)
  return {
    path: relative(root, path).split(sep).join('/'),
    kind: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file',
    size: info.size,
    modifiedAt: info.mtimeMs,
    mode: info.mode & 0o777,
    ...(info.isSymbolicLink() ? { target: await readlink(path) } : {})
  }
}

async function command(
  command: string,
  args: string[],
  cwd?: string,
  environment: Record<string, string> = {}
): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...environment }
    })
    let text = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('Remote Git operation timed out.'))
    }, 120_000)
    child.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString()
      if (Buffer.byteLength(text) > 512 * 1024) {
        child.kill('SIGTERM')
        reject(new Error('Git output is too large. Narrow the request.'))
      }
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolveResult(text)
      else reject(new Error(gitFailure(stderr, code)))
    })
  })
}

/**
 * Plain-language explanation for a Git failure, or null when the text names
 * none of the states this app can describe precisely.
 *
 * Every remote Git path   clone, workspace commands, and routed desktop Git
 * channels   classifies through here, so a user never sees a bare exit code.
 */
export function describeGitFailure(text: string): string | null {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/u.test(text))
    return 'GitHub’s host key changed on the Oven. Verify the new key fingerprint before trusting it.'
  if (/Host key verification failed/u.test(text))
    return 'GitHub is not trusted by OpenSSH on the Oven. Verify GitHub’s host fingerprint, then update the Oven’s known hosts.'
  if (/Repository not found|does not appear to be a git repository/iu.test(text))
    return 'The repository was not found, or this GitHub account has no access to it. Check the repository URL and account permissions.'
  if (/Permission denied.*publickey/iu.test(text))
    return 'GitHub rejected the SSH identity. The app mirrors the identity this computer uses; if it still fails, configure a dedicated Git key for this Oven.'
  if (/could not read from remote repository/iu.test(text))
    return 'GitHub refused the request over SSH. Check that this account can reach the repository and that the Oven’s Git identity is still valid.'
  if (/not a git repository/iu.test(text) || /no git repository/iu.test(text))
    return 'This Oven checkout is not a Git repository yet. Initialize it, or clone the project’s GitHub repository into it.'
  if (/Could not resolve hostname|Name or service not known/iu.test(text))
    return 'The Oven cannot resolve the Git host. Check its DNS and network connection.'
  if (/Connection timed out|Network is unreachable|Connection refused/iu.test(text))
    return 'The Oven cannot reach the Git host over SSH. Check its network and firewall.'
  if (/No space left on device/iu.test(text))
    return 'The Oven has no disk space available for this checkout.'
  if (/uncommitted changes|would be overwritten/iu.test(text))
    return 'The Oven checkout has uncommitted changes that this operation would overwrite. Commit or discard them first.'
  return null
}

function gitFailure(stderr: string, code: number | null): string {
  return (
    describeGitFailure(stderr) ??
    `Remote Git operation failed (${code ?? 'disconnected'}). Git could not complete the requested operation on the Oven.`
  )
}

/** The app-managed identities an Oven may hold, most specific first. */
const DEDICATED_IDENTITY = '.ssh/codeinoven-github'
const MIRRORED_IDENTITY = /^\.ssh\/codeinoven-local-github(?:\.pub)?$/u
const MIRRORED_TRUST = '.ssh/codeinoven-local-github-known-hosts'

/** One home-relative path inside a shell command Git will parse again. */
function optionPath(path: string): string {
  return `"${path.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
}

async function isFile(path: string): Promise<boolean> {
  return lstat(path)
    .then((info) => info.isFile())
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
}

/**
 * The Git-over-SSH environment every Oven-side Git command runs with.
 *
 * A dedicated CodeInOven identity for this Oven wins; otherwise the app mirror
 * of the user's own GitHub identity is used, paired with the host keys this
 * machine already trusts so the Oven inherits the user's trust decisions. Host
 * key checking stays strict and forwarding stays off in both cases.
 */
export async function ovenGitEnvironment(
  localIdentityFile?: unknown
): Promise<Record<string, string>> {
  const dedicated = join(homedir(), DEDICATED_IDENTITY)
  const hasDedicated = await isFile(dedicated)
  const mirror =
    !hasDedicated &&
    typeof localIdentityFile === 'string' &&
    MIRRORED_IDENTITY.test(localIdentityFile)
      ? join(homedir(), localIdentityFile)
      : null
  const identity = hasDedicated ? dedicated : mirror
  const trust =
    mirror && (await isFile(join(homedir(), MIRRORED_TRUST)))
      ? join(homedir(), MIRRORED_TRUST)
      : null
  const options = [
    ...(identity ? [`-i ${optionPath(identity)}`, '-o IdentitiesOnly=yes'] : []),
    ...(trust ? [`-o UserKnownHostsFile=${optionPath(trust)}`] : []),
    '-o StrictHostKeyChecking=yes',
    '-o BatchMode=yes',
    '-o ForwardAgent=no'
  ]
  return {
    GIT_SSH_VARIANT: 'ssh',
    GIT_SSH_COMMAND: `ssh ${options.join(' ')}`
  }
}

/** Clone once into a sibling staging directory and publish only a verified repo. */
async function cloneIntoScope(
  root: string,
  url: string,
  localIdentityFile?: unknown
): Promise<string> {
  const previous = cloneLocks.get(root) ?? Promise.resolve()
  let release = (): void => undefined
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock
  })
  const tail = previous.catch(() => undefined).then(() => current)
  cloneLocks.set(root, tail)
  await previous.catch(() => undefined)
  try {
    await mkdir(dirname(root), { recursive: true, mode: 0o700 })
    try {
      const existing = await lstat(root)
      if (!existing.isDirectory())
        throw new Error('The scope checkout path already exists and is not a directory.')
      const origin = (await command('git', ['remote', 'get-url', 'origin'], root)).trim()
      const top = (await command('git', ['rev-parse', '--show-toplevel'], root)).trim()
      if (origin !== url || resolve(top) !== resolve(root))
        throw new Error(
          'The existing scope checkout belongs to a different repository. It was left untouched.'
        )
      return root
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const staged = `${root}.codeinoven-${randomUUID()}.tmp`
    try {
      await command(
        'git',
        ['clone', '--', url, staged],
        undefined,
        await ovenGitEnvironment(localIdentityFile)
      )
      const origin = (await command('git', ['remote', 'get-url', 'origin'], staged)).trim()
      const top = (await command('git', ['rev-parse', '--show-toplevel'], staged)).trim()
      if (origin !== url || resolve(top) !== resolve(staged))
        throw new Error('The cloned repository failed scope verification.')
      await rename(staged, root)
      return root
    } finally {
      await rm(staged, { recursive: true, force: true })
    }
  } finally {
    release()
    void tail.then(() => {
      if (cloneLocks.get(root) === tail) cloneLocks.delete(root)
    })
  }
}

/** Bounded asynchronous filesystem and Git requests executed on the selected machine. */
export async function ovenWorkspace(raw: unknown): Promise<OvenWorkspaceResult> {
  if (!raw || typeof raw !== 'object') throw new Error('Workspace request required.')
  const input = raw as OvenWorkspaceRequest
  const root = workspaceRoot(input.root)
  if (input.operation === 'ensure') {
    await mkdir(root, { recursive: true, mode: 0o700 })
    return { root: await realpath(root) }
  }
  if (input.operation === 'reserve') {
    await mkdir(dirname(root), { recursive: true, mode: 0o700 })
    await mkdir(root, { mode: 0o700 })
    return { root: await realpath(root) }
  }
  if (input.operation === 'clone') {
    const url =
      typeof input.url === 'string' && input.url.length <= 4096
        ? normalizeGitHubSshUrl(input.url)
        : null
    if (!url) throw new Error('Use a GitHub SSH repository URL.')
    return { root: await cloneIntoScope(root, url, input.localIdentityFile) }
  }
  if (input.operation === 'git') {
    const args =
      input.action === 'status'
        ? ['status', '--short', '--branch']
        : input.action === 'diff'
          ? ['diff', '--no-ext-diff', '--no-textconv', '--']
          : input.action === 'log'
            ? ['log', '-20', '--oneline']
            : input.action === 'branch'
              ? ['rev-parse', '--abbrev-ref', 'HEAD']
              : null
    if (!args) throw new Error('Unsupported Git operation.')
    return { root, text: await command('git', args, root) }
  }
  const path = await workspacePath(
    root,
    input.path,
    ['write', 'mkdir', 'symlink', 'replace', 'publishFile'].includes(input.operation)
  )
  if (input.operation === 'publishFile') {
    const staged = await workspacePath(root, input.staged)
    if (!(await lstat(staged)).isFile())
      throw new Error('Only a staged regular file can be published.')
    await link(staged, path)
    await unlink(staged)
    return { root, file: await fileInfo(root, path) }
  }
  if (input.operation === 'replace') {
    if (!Number.isInteger(input.mode) || input.mode < 0 || input.mode > 0o777)
      throw new Error('Invalid file mode.')
    if (input.expectedData !== undefined) {
      if (typeof input.expectedData !== 'string' || input.expectedData.length > CHUNK * 1.4)
        throw new Error('Invalid editor original.')
      const current = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const buffer = Buffer.alloc(CHUNK + 1)
        const { bytesRead } = await current.read(buffer, 0, buffer.length, 0)
        if (
          bytesRead > CHUNK ||
          !buffer.subarray(0, bytesRead).equals(Buffer.from(input.expectedData, 'base64'))
        )
          throw new Error('The file changed on the Oven. Reload it before saving.')
      } finally {
        await current.close()
      }
    }
    const staged = await workspacePath(root, input.staged)
    await chmod(staged, input.mode)
    await rename(staged, path)
    return { root }
  }
  if (input.operation === 'stat') return { root, file: await fileInfo(root, path) }
  if (input.operation === 'list') {
    const entries: string[] = []
    for await (const entry of await opendir(path)) {
      if (input.after && entry.name.localeCompare(input.after) <= 0) continue
      const index = entries.findIndex((name) => entry.name.localeCompare(name) < 0)
      if (index < 0) {
        if (entries.length < 128) entries.push(entry.name)
      } else entries.splice(index, 0, entry.name)
      if (entries.length > 128) entries.pop()
    }
    const files: OvenFile[] = []
    for (const name of entries) files.push(await fileInfo(root, join(path, name)))
    return { root, files, ...(entries.length === 128 ? { after: entries.at(-1) } : {}) }
  }
  if (input.operation === 'mkdir') {
    await mkdir(path, { recursive: input.exclusive !== true, mode: 0o700 })
    return { root }
  }
  if (input.operation === 'move') {
    const destination = await workspacePath(root, input.to, true)
    if (destination === path) throw new Error('The entry is already at that location.')
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    // Adopting a file never overwrites one the Oven already holds: the caller
    // only moves an app-owned transcript when its destination is still empty.
    if (
      await lstat(destination).then(
        () => true,
        () => false
      )
    )
      throw new Error('The destination already exists on the Oven.')
    await rename(path, destination)
    return { root }
  }
  if (input.operation === 'symlink') {
    if (typeof input.target !== 'string' || isAbsolute(input.target) || input.target.includes('\0'))
      throw new Error('Transfer only relative symbolic links.')
    const target = resolve(dirname(path), input.target)
    if (relative(root, target).startsWith('..'))
      throw new Error('Symbolic link leaves the workspace.')
    await symlink(input.target, path)
    return { root }
  }
  if (input.operation !== 'read' && input.operation !== 'write')
    throw new Error('Unsupported workspace operation.')
  if (!Number.isSafeInteger(input.offset) || input.offset < 0)
    throw new Error('Invalid file offset.')
  const file = await open(
    path,
    input.operation === 'read'
      ? constants.O_RDONLY | constants.O_NOFOLLOW
      : constants.O_RDWR |
          constants.O_NOFOLLOW |
          (input.exclusive ? constants.O_CREAT | constants.O_EXCL : 0),
    0o600
  )
  try {
    if (input.operation === 'read') {
      const buffer = Buffer.alloc(CHUNK)
      const { bytesRead } = await file.read(buffer, 0, CHUNK, input.offset)
      return {
        root,
        data: buffer.subarray(0, bytesRead).toString('base64'),
        size: (await file.stat()).size
      }
    }
    if (
      typeof input.data !== 'string' ||
      input.data.length > CHUNK * 1.4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(input.data)
    )
      throw new Error('Invalid file data.')
    const buffer = Buffer.from(input.data, 'base64')
    let written = 0
    while (written < buffer.length) {
      const result = await file.write(
        buffer,
        written,
        buffer.length - written,
        input.offset + written
      )
      if (!result.bytesWritten) throw new Error('File write made no progress.')
      written += result.bytesWritten
    }
    if (input.mode !== undefined) {
      if (!Number.isInteger(input.mode) || input.mode < 0 || input.mode > 0o777)
        throw new Error('Invalid file mode.')
      await chmod(path, input.mode)
    }
    return { root }
  } finally {
    await file.close()
  }
}
