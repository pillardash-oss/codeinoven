import { parentPort, workerData } from 'node:worker_threads'
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { lintDesignCraft } from '../../lib/design/design-review'

export async function reviewDesignFile(file: string) {
  const info = await stat(file)
  if (info.size > 512 * 1024) throw new Error('Craft review accepts screens up to 512 KiB')
  const content = await readFile(file, 'utf8')
  return {
    hash: createHash('sha256').update(content).digest('hex'),
    findings: lintDesignCraft(content)
  }
}
if (parentPort)
  void reviewDesignFile(workerData as string)
    .then((result) => parentPort!.postMessage({ result }))
    .catch((error: unknown) =>
      parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) })
    )
