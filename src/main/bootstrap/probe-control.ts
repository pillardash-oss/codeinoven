/**
 * Dev-only control channel that starts and moves a turn from the main process.
 *
 * Why this exists: the app's only way to start an agent turn is the composer,
 * which is a rich editor whose model does not follow synthetic input. A
 * two-instance test of the thread hand-off therefore cannot be driven from the
 * window at all, and the part that broke last time (a move must carry the nested
 * workers instead of ending them) lives exactly there, across two processes.
 *
 * A probe started with `CODEINOVEN_PROBE_CONTROL=1` watches one directory in its
 * own config root and executes the request files it finds:
 *
 *   {"id":"1","action":"send","projectId":"…","threadId":"…","text":"…"}
 *   {"id":"2","action":"transfer","projectId":"…","threadId":"…"}
 *
 * The answer is written beside the request as `response-<id>.json`, so a test
 * driver reads the verdict instead of guessing from logs.
 *
 * Guards, because a channel that runs agents on command is a loaded gun:
 *  - only when the environment variable is set, which `dev:probe` callers do
 *    explicitly and a real launch never inherits;
 *  - only inside the instance's own config root;
 *  - nothing is polled: one non-persistent watcher, so it can never keep the
 *    app alive or wake an idle one;
 *  - every action goes through the same engine entry point the IPC handler
 *    uses, so a probe exercises the real path rather than a shortcut.
 */

import { mkdirSync, watch } from 'node:fs'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getConfigRoot } from '../../lib/utils'
import type { ChatEngine } from '../chat/chat-engine'
import type { ThreadTransferService } from '../chat/thread-transfer-service'
import { Logger } from '../system/logger'

/** Set by the caller of `dev:probe` to arm this channel. Never set by a launch. */
export const PROBE_CONTROL_ENV = 'CODEINOVEN_PROBE_CONTROL'

/** Directory inside the probe's config root holding requests and answers. */
const PROBE_CONTROL_DIRECTORY = 'probe-control'

/** Everything one request file may ask for. */
type ProbeControlRequest =
  | {
      id: string
      action: 'send'
      projectId: string
      threadId: string
      text: string
      targetPid?: number
    }
  | { id: string; action: 'transfer'; projectId: string; threadId: string; targetPid?: number }

/** The answer a test driver reads back. */
interface ProbeControlResponse {
  id: string
  action: string
  ok: boolean
  error?: string
  result?: unknown
}

export interface ProbeControlHost {
  readonly chatEngine: ChatEngine
  readonly threadTransfer: ThreadTransferService
}

/** The armed channel, so the caller can disarm it with the rest of shutdown. */
export interface ProbeControlHandle {
  stop(): void
}

/** One armed channel, or null when this launch is not a probe under test. */
export function installProbeControl(host: ProbeControlHost): ProbeControlHandle | null {
  if (process.env[PROBE_CONTROL_ENV] !== '1') return null
  const directory = join(getConfigRoot(), PROBE_CONTROL_DIRECTORY)
  try {
    mkdirSync(directory, { recursive: true })
  } catch (error) {
    Logger.error('Probe control could not create its directory:', error)
    return null
  }
  const handled = new Set<string>()
  let armed = true

  const drain = async (): Promise<void> => {
    if (!armed) return
    let names: string[]
    try {
      names = await readdir(directory)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('response-')) continue
      if (handled.has(name)) continue
      handled.add(name)
      const path = join(directory, name)
      let request: ProbeControlRequest | null = null
      try {
        request = parseRequest(await readFile(path, 'utf8'))
      } catch (error) {
        Logger.error('Probe control could not read a request:', error)
      }
      if (!request) {
        await removeQuietly(path)
        continue
      }
      // Two probes share one config root, so one directory serves both. A
      // request names the instance it is for, and every other instance leaves
      // it alone instead of deleting a job it must not run.
      if (request.targetPid !== undefined && request.targetPid !== process.pid) {
        handled.delete(name)
        continue
      }
      await run(host, request, directory)
      await removeQuietly(path)
    }
  }

  const watcher = watch(directory, { persistent: false }, () => {
    void drain()
  })
  void drain()

  Logger.info('Probe control armed', { directory })
  return {
    stop() {
      armed = false
      watcher.close()
    }
  }
}

/** Parse one request file, or null when it is not a request this channel runs. */
function parseRequest(text: string): ProbeControlRequest | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const id = typeof record['id'] === 'string' ? record['id'] : ''
  const projectId = typeof record['projectId'] === 'string' ? record['projectId'] : ''
  const threadId = typeof record['threadId'] === 'string' ? record['threadId'] : ''
  const action = record['action']
  const targetPid = typeof record['targetPid'] === 'number' ? record['targetPid'] : undefined
  const addressed = targetPid === undefined ? {} : { targetPid }
  if (id === '' || projectId === '' || threadId === '') return null
  if (action === 'transfer') return { id, action, projectId, threadId, ...addressed }
  if (action !== 'send') return null
  const prompt = typeof record['text'] === 'string' ? record['text'] : ''
  if (prompt === '') return null
  return { id, action: 'send', projectId, threadId, text: prompt, ...addressed }
}

/** Run one request and write its verdict where the driver can read it. */
async function run(
  host: ProbeControlHost,
  request: ProbeControlRequest,
  directory: string
): Promise<void> {
  const response: ProbeControlResponse = { id: request.id, action: request.action, ok: false }
  try {
    if (request.action === 'send') {
      const thread = await host.chatEngine.threadManager.getThread(
        request.projectId,
        request.threadId
      )
      if (!thread?.settings) throw new Error('The thread has no settings to send with.')
      await host.chatEngine.sendPrompt(
        request.projectId,
        request.threadId,
        thread.settings,
        request.text,
        []
      )
      response.ok = true
    } else {
      response.result = await host.threadTransfer.transferToThisInstance(
        request.projectId,
        request.threadId
      )
      response.ok = true
    }
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error)
    Logger.error('Probe control request failed:', { action: request.action, error })
  }
  try {
    await writeFile(join(directory, `response-${request.id}.json`), JSON.stringify(response))
  } catch (error) {
    Logger.error('Probe control could not write its answer:', error)
  }
}

async function removeQuietly(path: string): Promise<void> {
  try {
    await rm(path, { force: true })
  } catch {
    /* a leftover request is retried by the next watcher event */
  }
}
