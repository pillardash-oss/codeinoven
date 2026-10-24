/// <reference types="electron-vite/node" />
import {
  DEFAULT_IDE_LANGUAGE_SERVERS,
  IDE_SERVER_PACKAGES,
  type IdeLanguageServer
} from '../../lib/ide-language-servers'
import createWorker from './ide-worker.ts?nodeWorker'
import type { Worker } from 'node:worker_threads'
import type { IdeRequest, IdeResponse } from '../../lib/editor-ide'
import { buildProcessEnvironmentAsync, resolvePackageCommand } from '../drivers/cli-environment'
import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, join } from 'node:path'

/** One lazy broker. Language servers and grep never run in Electron's main thread. */
export class IdeService {
  private worker?: Worker
  private readonly serverPids = new Set<number>()
  private sequence = 0
  private installer?: ChildProcess
  private installQueue: Promise<void> = Promise.resolve()
  private installs = new Map<string, Promise<void>>()
  private stopping = false
  private documentOwners = new Set<string>()
  get hasOpenDocuments(): boolean {
    return this.documentOwners.size > 0
  }
  private pending = new Map<
    number,
    {
      resolve: (value: IdeResponse) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  async request(
    root: string,
    request: IdeRequest,
    servers: IdeLanguageServer[] = DEFAULT_IDE_LANGUAGE_SERVERS
  ): Promise<IdeResponse> {
    if (request.action === 'close') this.documentOwners.delete(request.owner)
    else if (
      request.path &&
      ['sync', 'capabilities', 'definition', 'references', 'hover'].includes(request.action)
    )
      this.documentOwners.add(request.owner)
    if ((request.action === 'close' || request.action === 'cancel') && !this.worker) return {}
    if (this.pending.size >= 32) throw new Error('Editor intelligence is busy. Try again shortly.')
    const toolRoot = join(app.getPath('userData'), 'ide-language-servers')
    const inherited = await buildProcessEnvironmentAsync()
    const env = {
      ...inherited,
      CODEINOVEN_IDE_BIN: join(toolRoot, 'node_modules', '.bin'),
      PATH: `${join(toolRoot, 'node_modules', '.bin')}${delimiter}${inherited.PATH ?? ''}`
    }
    if (request.action === 'inventory') {
      const installations: NonNullable<IdeResponse['installations']> = []
      for (const server of servers) {
        const packageName = IDE_SERVER_PACKAGES[server.command]?.[0].split('@')[0]
        const managed = join(toolRoot, 'node_modules', '.bin', server.command)
        const candidates = packageName ? [managed] : []
        if (server.command.includes('/') || server.command.includes('\\'))
          candidates.push(server.command)
        else
          for (const directory of (inherited.PATH ?? '').split(delimiter).filter(Boolean))
            candidates.push(join(directory, server.command))
        let executable: string | undefined
        for (const candidate of candidates) {
          try {
            await access(candidate, constants.X_OK)
            executable = candidate
            break
          } catch {
            /* Try the next PATH entry. */
          }
        }
        let version: string | undefined
        if (executable === managed && packageName) {
          try {
            const manifest: unknown = JSON.parse(
              await readFile(join(toolRoot, 'node_modules', packageName, 'package.json'), 'utf8')
            )
            if (
              manifest &&
              typeof manifest === 'object' &&
              'version' in manifest &&
              typeof manifest.version === 'string'
            )
              version = manifest.version
          } catch {
            /* A partial installation remains distinguishable from a known version. */
          }
        }
        installations.push({
          serverId: server.id,
          source: !executable ? 'missing' : executable === managed ? 'managed' : 'external',
          executable,
          packageName,
          version
        })
      }
      if (request.query === 'updates') {
        const managed = installations.filter(
          (item) => item.source === 'managed' && item.packageName
        )
        for (let offset = 0; offset < managed.length; offset += 3) {
          await Promise.all(
            managed.slice(offset, offset + 3).map(async (item) => {
              try {
                const response = await fetch(
                  `https://registry.npmjs.org/${encodeURIComponent(item.packageName!)}/latest`,
                  { signal: AbortSignal.timeout(8000) }
                )
                if (!response.ok) throw new Error(`Registry returned ${response.status}`)
                const metadata: unknown = await response.json()
                if (
                  metadata &&
                  typeof metadata === 'object' &&
                  'version' in metadata &&
                  typeof metadata.version === 'string'
                )
                  item.latestVersion = metadata.version
              } catch {
                item.updateError = 'Update check unavailable'
              }
            })
          )
        }
      }
      return { installations }
    }
    if (request.action === 'install') {
      const server = servers.find((server) => server.id === request.serverId)
      const packages = server && IDE_SERVER_PACKAGES[server.command]
      if (!packages)
        throw new Error('Install this custom executable manually, then choose its path.')
      const existing = this.installs.get(server.id)
      if (existing) {
        await existing
        return {}
      }
      if (this.installs.size >= 8)
        throw new Error('Eight language servers are already queued for installation.')
      const task = this.installQueue.then(async () => {
        if (this.stopping) throw new Error('Application is stopping')
        await mkdir(toolRoot, { recursive: true })
        // Anchor package installation here rather than in a parent project.
        await writeFile(
          join(toolRoot, 'package.json'),
          '{"name":"codeinoven-ide-tools","private":true}',
          { flag: 'wx' }
        ).catch((error: unknown) => {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
        })
        const launch = resolvePackageCommand(
          'install',
          packages[0],
          ['--ignore-scripts', ...packages.slice(1)],
          env
        )
        await new Promise<void>((resolve, reject) => {
          const child = spawn(launch.command, launch.args, {
            cwd: toolRoot,
            env: {
              ...launch.env,
              BUN_INSTALL_CACHE_DIR: join(toolRoot, 'cache'),
              npm_config_cache: join(toolRoot, 'cache')
            },
            shell: launch.shell,
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: true
          })
          this.installer = child
          let detail = ''
          let timedOut = false
          child.stderr?.on('data', (chunk: Buffer) => {
            detail = (detail + chunk.toString()).slice(-4000)
          })
          const timeout = setTimeout(() => {
            timedOut = true
            child.kill('SIGKILL')
          }, 120_000)
          child.once('error', (error) => {
            clearTimeout(timeout)
            this.installer = undefined
            reject(new Error(`Cannot start the language-server installer. ${error.message}`))
          })
          child.once('exit', (code) => {
            clearTimeout(timeout)
            this.installer = undefined
            if (timedOut) reject(new Error('Language server installation timed out. Try again.'))
            else if (code === 0) resolve()
            else reject(new Error(`Language server installation failed. ${detail}`))
          })
        })
      })
      this.installs.set(server.id, task)
      this.installQueue = task.catch(() => undefined)
      try {
        await task
      } finally {
        this.installs.delete(server.id)
      }
      return {}
    }
    if (request.action === 'check' && !root) {
      await mkdir(toolRoot, { recursive: true })
      root = toolRoot
    }
    if (!this.worker) {
      const worker = createWorker({ resourceLimits: { maxOldGenerationSizeMb: 128 } })
      this.worker = worker
      worker.unref()
      worker.on(
        'message',
        (message: {
          id: number
          result?: IdeResponse
          error?: string
          serverPid?: number
          add?: boolean
          idle?: boolean
        }) => {
          if (message.serverPid !== undefined) {
            if (message.add) this.serverPids.add(message.serverPid)
            else this.serverPids.delete(message.serverPid)
            if (message.idle && this.pending.size === 0 && this.serverPids.size === 0) {
              this.worker = undefined
              void worker.terminate()
            }
            return
          }
          const pending = this.pending.get(message.id)
          if (!pending) return
          clearTimeout(pending.timer)
          this.pending.delete(message.id)
          if (message.error) pending.reject(new Error(message.error))
          else pending.resolve(message.result ?? {})
          if (message.idle && this.pending.size === 0 && this.serverPids.size === 0) {
            this.worker = undefined
            void worker.terminate()
          }
        }
      )
      const fail = (): void => {
        if (this.worker !== worker) return
        this.worker = undefined
        this.killServers()
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer)
          pending.reject(new Error('Editor intelligence worker stopped'))
        }
        this.pending.clear()
      }
      worker.on('error', fail)
      worker.on('exit', fail)
    }
    const worker = this.worker
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Editor intelligence timed out'))
      }, 20_000)
      this.pending.set(id, { resolve, reject, timer })
      worker.postMessage({ id, root, request, env, servers })
    })
  }

  private killServers(): void {
    for (const pid of this.serverPids) {
      try {
        process.kill(pid)
      } catch {
        /* Process already exited. */
      }
    }
    this.serverPids.clear()
  }

  configure(servers: IdeLanguageServer[]): void {
    this.worker?.postMessage({ configure: servers })
  }

  stop(): void {
    this.stopping = true
    this.installer?.kill()
    this.worker?.postMessage({ stop: true })
    this.killServers()
  }
}

export const ideService = new IdeService()
