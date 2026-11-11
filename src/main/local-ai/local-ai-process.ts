/**
 * The two questions the Local AI page asks a started server: is it answering,
 * and which model does it hold.
 *
 * Both engines answer `/v1/models`, but only llama.cpp names the loaded model
 * there. `mlx_lm.server` lists every MLX repository in the download cache, so the
 * model a row would be adopting is read from the command line of the process that
 * holds the port instead. That is also what makes stopping safe: a port is only
 * ever asked to end a process that is one of these two servers, never whatever
 * else happens to be listening.
 */
import {
  llamaCppAddressableModelId,
  tokenizeLlamaCppFlags,
  type LlamaCppProbeResult,
  type LocalAiRuntimeId
} from '../../lib/llama-cpp'
import { listeningPids, processCommand } from './local-ai-binary'

const PROBE_TIMEOUT_MS = 2_500
/** How long a terminated server is given before the kill is escalated. */
const TERMINATE_POLL_MS = 200

/** Whether a process command line belongs to the engine the page asked about. */
function isEngineProcess(command: string, runtime: LocalAiRuntimeId): boolean {
  return runtime === 'mlx' ? /mlx_lm\.server/u.test(command) : /llama-server/u.test(command)
}

/** The `--model` a process was launched with, empty when it names none. */
function modelArgument(command: string): string {
  const tokens = tokenizeLlamaCppFlags(command)
  for (const [index, token] of tokens.entries()) {
    if (token === '--model') return tokens[index + 1] ?? ''
    if (token.startsWith('--model=')) return token.slice('--model='.length)
  }
  return ''
}

/** The command line of the process listening on a port, empty when there is none. */
async function listeningCommand(port: number): Promise<string> {
  for (const pid of await listeningPids(port)) {
    const command = await processCommand(pid)
    if (command.length > 0) return command
  }
  return ''
}

/**
 * End a server that holds a port without a PTY behind it.
 *
 * A local server can outlive the app instance that launched it, and the row it
 * belongs to then shows a process the card can neither stop nor start over. The
 * stop asks whoever listens on the port to end, but only when the command line is
 * one of the engines this page runs.
 */
export async function stopLocalAiServer(port: number, runtime: LocalAiRuntimeId): Promise<boolean> {
  let stopped = false
  for (const pid of await listeningPids(port)) {
    if (!isEngineProcess(await processCommand(pid), runtime)) continue
    try {
      process.kill(pid, 'SIGTERM')
      stopped = true
    } catch {
      continue
    }
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, TERMINATE_POLL_MS))
      if (!(await listeningPids(port)).includes(pid)) break
      if (attempt === 14) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // The process is already gone; the port simply reported late.
        }
      }
    }
  }
  return stopped
}

/**
 * Ask a running server whether it answers, and which model it holds.
 *
 * This is the only thing that flips a card to "running": a process that is alive
 * but still loading a model is not ready to answer turns.
 */
export async function probeLocalAiServer(
  baseUrl: string,
  port: number,
  runtime: LocalAiRuntimeId
): Promise<LlamaCppProbeResult> {
  let response: Response
  try {
    response = await fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
  } catch {
    return { ready: false, models: [], error: 'The server is not answering yet' }
  }
  if (!response.ok) {
    return { ready: false, models: [], error: `The server answered ${response.status}` }
  }
  if (runtime === 'mlx') return { ready: true, models: await mlxLoadedModels(port), error: '' }
  try {
    const body: unknown = await response.json()
    return { ready: true, models: readModelIds(body), error: '' }
  } catch {
    return { ready: false, models: [], error: 'The server answered with invalid JSON' }
  }
}

/**
 * The model an MLX server holds, as one id.
 *
 * The endpoint lists the whole download cache, so an empty answer is better than
 * a wrong one: the row then reports the server as answering without claiming it
 * serves that row's model.
 */
async function mlxLoadedModels(port: number): Promise<string[]> {
  const command = await listeningCommand(port)
  if (!isEngineProcess(command, 'mlx')) return []
  const model = modelArgument(command)
  return model.length > 0 ? [model] : []
}

function readModelIds(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return []
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  const ids: string[] = []
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue
    const id = (item as { id?: unknown }).id
    if (typeof id !== 'string' || id.length === 0 || id.length > 512) continue
    // llama.cpp names its model after the `-m` path it was started with; the
    // card shows the file name, so the probe reports the same id everywhere.
    const addressable = llamaCppAddressableModelId(id)
    if (!ids.includes(addressable)) ids.push(addressable)
  }
  return ids
}
