/**
 * What the Local AI page states about the inference runtimes this machine can
 * drive.
 *
 * One report for all three, because the page presents them as one decision: which
 * runtime loads a local model, and how long that model then stays in memory. The
 * llama.cpp answer comes from the runtime service that discovers and downloads the
 * binary; MLX and Core ML are the bundled speech workers, which exist only on the
 * Apple Silicon builds that ship them.
 */
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { LocalAiRuntimeSummary } from '../../lib/llama-cpp'
import { appResourcesRoot, isShippedBuild } from '../bootstrap/app-resources'
import { sharedLlamaRuntimeService } from '../speech/llama-runtime-service'

/** Root of the bundled speech workers: packaged build, or the dev runtime tree. */
function speechWorkerPath(worker: string): string {
  const root = appResourcesRoot()
  return isShippedBuild()
    ? join(root, 'speech', worker)
    : join(root, 'speech/runtime/darwin-arm64', worker)
}

/** A bundled worker only runs on the Apple Silicon build that carries it. */
async function workerAvailable(worker: string): Promise<boolean> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return false
  try {
    await access(speechWorkerPath(worker))
    return true
  } catch {
    return false
  }
}

function unsupportedDetail(): string {
  return process.platform === 'darwin' && process.arch === 'arm64'
    ? 'The bundled worker for this runtime is missing from this install.'
    : 'This runtime needs an Apple Silicon Mac.'
}

/** Every local inference runtime, with what the app runs on it here. */
export async function detectLocalAiRuntimes(): Promise<LocalAiRuntimeSummary[]> {
  const [status, mlxAvailable, coremlAvailable] = await Promise.all([
    sharedLlamaRuntimeService().status(),
    workerAvailable('mlx-worker'),
    workerAvailable('coreml-worker')
  ])
  const build = status.selectedBuild
  const versionLine = [status.version ?? '', build ? `build ${build}` : '']
    .filter((part) => part.length > 0)
    .join(' · ')
  return [
    {
      id: 'llama.cpp',
      label: 'llama.cpp',
      available: status.available,
      detail: status.available
        ? [versionLine, status.selectedPath ?? ''].filter((part) => part.length > 0).join(' · ')
        : 'llama-server was not found on this machine.',
      uses: ['Speech cleanup', 'Search embeddings']
    },
    {
      id: 'mlx',
      label: 'MLX',
      available: mlxAvailable,
      detail: mlxAvailable ? speechWorkerPath('mlx-worker') : unsupportedDetail(),
      uses: ['Speech to text', 'Speech synthesis']
    },
    {
      id: 'coreml',
      label: 'Core ML',
      available: coremlAvailable,
      detail: coremlAvailable ? speechWorkerPath('coreml-worker') : unsupportedDetail(),
      uses: ['Speech to text']
    }
  ]
}
