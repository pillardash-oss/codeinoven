/**
 * Build the pinned native PCM speech capture worker (macOS on Apple Silicon
 * only).
 *
 * The executable resolves through the shared build cache, so a fresh checkout  
 * including a managed Git worktree, whose `resources/speech/runtime` is
 * gitignored   installs the project root's build instead of recompiling it (see
 * `scripts/lib/speech-worker-build.ts`).
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureSpeechWorker, speechWorkersSupportedHere } from './lib/speech-worker-build'

const projectRoot = join(fileURLToPath(new URL('..', import.meta.url)))

if (!speechWorkersSupportedHere()) process.exit(0)

await ensureSpeechWorker(projectRoot, {
  label: 'Native speech capture worker',
  cacheName: 'speech-capture-worker',
  packageDirectory: join(projectRoot, 'resources/speech/native-capture-src'),
  product: 'speech-capture-worker',
  scratchDirectory: join(projectRoot, '.cio/tmp/native-speech-capture-build')
})
