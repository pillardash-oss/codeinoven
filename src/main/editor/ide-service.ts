/// <reference types="electron-vite/node" />
import {
  DEFAULT_IDE_LANGUAGE_SERVERS,
  type IdeLanguageServer
} from '../../lib/ide-language-servers'
import createWorker from './ide-worker.ts?nodeWorker'
import type { Worker } from 'node:worker_threads'
import type { IdeRequest, IdeResponse } from '../../lib/editor-ide'
import { buildProcessEnvironmentAsync } from '../drivers/cli-environment'

/** One lazy broker. Language servers and grep never run in Electron's main thread. */
export class IdeService {
  private worker?: Worker
  private readonly serverPids = new Set<number>()
  private sequence = 0
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
    if ((request.action === 'close' || request.action === 'cancel') && !this.worker) return {}
    if (this.pending.size >= 32) throw new Error('Editor intelligence is busy. Try again shortly.')
    const env = await buildProcessEnvironmentAsync()
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
    this.worker?.postMessage({ stop: true })
    this.killServers()
  }
}

export const ideService = new IdeService()
