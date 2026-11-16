/**
 * The Local AI models whose weights are still arriving, for the close gate.
 *
 * A row saved from a Hugging Face reference is a tag until the engine fetches it,
 * and nothing in the app can resume that fetch: the downloader the engines ship
 * starts every file from zero, so a quit in the middle of one costs every byte
 * already fetched. The close prompt is the only place the user is told that before
 * it happens, which is why the gate needs to see these downloads at all.
 *
 * The truth lives in the PTY service, not in the page: a renderer reload leaves
 * the process fetching with no card to show it, and the argv the process was
 * started with is what says whether it is fetching or only loading.
 */
import { basename, isAbsolute } from 'node:path'
import {
  localAiPtyId,
  parseHuggingFaceModelReference,
  type LocalAiRuntimeId
} from '../../lib/llama-cpp'
import type { RunningPtyCommand } from '../system/pty-service'
import { mlxModelCached } from './local-ai-model-location'

/** The ids every Local AI row's server runs under. */
const LOCAL_AI_PTY_PREFIX = localAiPtyId('')

/** The flags llama.cpp takes a repository (and optional quant) on. */
const LLAMA_CPP_HF_FLAGS = new Set(['-hf', '-hfr', '--hf-repo'])

/**
 * The Hugging Face reference an argv asks the engine to fetch, empty when the
 * command loads weights that are already on disk.
 *
 * Both engines are read here because both rows are launched the same way: a
 * llama.cpp row names a repository with `-hf`, and an MLX row passes the same
 * reference to `--model`, which takes a hub id or a local folder.
 */
function referenceFromArgv(argv: readonly string[]): string {
  for (const [index, token] of argv.entries()) {
    const next = argv[index + 1] ?? ''
    const flagValue = LLAMA_CPP_HF_FLAGS.has(token)
      ? next
      : token.startsWith('--hf-repo=')
        ? token.slice('--hf-repo='.length)
        : token.startsWith('--model=')
          ? token.slice('--model='.length)
          : token === '--model'
            ? next
            : ''
    if (flagValue.length === 0) continue
    // A path is a model the user already has; only a hub id is a download.
    if (isAbsolute(flagValue)) return ''
    if (!parseHuggingFaceModelReference(flagValue)) continue
    return flagValue
  }
  return ''
}

/**
 * The engine a running argv belongs to, from the executable it starts.
 *
 * The two engines are the ones this app launches for a row, and both are named
 * servers: an MLX row is `mlx_lm.server`, a GGUF row is `llama-server`.
 */
function runtimeFromArgv(argv: readonly string[]): LocalAiRuntimeId | null {
  const name = basename(argv[0] ?? '')
  if (name.startsWith('mlx_lm.server')) return 'mlx'
  if (name.startsWith('llama-server')) return 'llama.cpp'
  return null
}

/**
 * The Local AI downloads a quit would interrupt, one entry per row still fetching.
 *
 * `resumable` is the fact the close prompt needs, and it belongs to the engine, not
 * to the row: llama.cpp keeps a `.downloadInProgress` file and asks the server for
 * the rest of it next time, while the MLX engine's downloader writes a temp file
 * unique to each attempt and starts over. A GGUF fetch therefore survives a quit
 * and an MLX fetch does not.
 *
 * A row that has finished its fetch and is only loading reads as nothing here: its
 * bytes are on disk, so a quit costs it nothing but the wait. An MLX row is checked
 * against its own snapshot for exactly that reason.
 */
export function localAiDownloadsInFlight(sessions: readonly RunningPtyCommand[]): Array<{
  entryId: string
  reference: string
  resumable: boolean
}> {
  const downloads: Array<{ entryId: string; reference: string; resumable: boolean }> = []
  for (const session of sessions) {
    if (!session.id.startsWith(LOCAL_AI_PTY_PREFIX)) continue
    const reference = referenceFromArgv(session.argv)
    if (reference.length === 0) continue
    const runtime = runtimeFromArgv(session.argv)
    if (!runtime) continue
    // A complete MLX snapshot means this row is loading, not fetching.
    if (runtime === 'mlx' && mlxModelCached(reference)) continue
    downloads.push({
      entryId: session.id.slice(LOCAL_AI_PTY_PREFIX.length),
      reference,
      resumable: runtime === 'llama.cpp'
    })
  }
  return downloads
}
