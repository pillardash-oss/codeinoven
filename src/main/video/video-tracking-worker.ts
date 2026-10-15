import { parentPort, workerData } from 'node:worker_threads'
import { join } from 'node:path'
import { atomicWrite } from '../../lib/utils'
import { startVideoProcess } from './video-process'

interface TrackingRequest {
  root: string
  source: string
  output: string
  start: number
  duration: number
  x: number
  y: number
  width: number
  height: number
}
const request = workerData as TrackingRequest
const controller = new AbortController()
parentPort?.on('message', () => controller.abort())

/** Local template tracking, deliberately separate from semantic object segmentation. */
async function track(): Promise<void> {
  const width = 320,
    height = 180,
    fps = 10
  const frameBytes = width * height
  const boxWidth = Math.max(4, Math.min(64, Math.round(request.width * width)))
  const boxHeight = Math.max(4, Math.min(64, Math.round(request.height * height)))
  let x = Math.round(request.x * width),
    y = Math.round(request.y * height)
  x = Math.max(0, Math.min(width - boxWidth, x))
  y = Math.max(0, Math.min(height - boxHeight, y))
  let template: Uint8Array | undefined
  let frameIndex = 0
  const points: { time: number; x: number; y: number; confidence: number }[] = []
  const process = await startVideoProcess(
    [
      '-ss',
      String(request.start),
      '-t',
      String(request.duration),
      '-i',
      request.source,
      '-an',
      '-vf',
      `scale=${width}:${height},fps=${fps},format=gray`,
      '-f',
      'rawvideo',
      'pipe:1'
    ],
    request.root,
    controller.signal
  )
  process.child.stdin.end()
  let pending = Buffer.alloc(0)
  try {
    for await (const raw of process.child.stdout) {
      const chunk = raw as Buffer
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= frameBytes) {
        controller.signal.throwIfAborted()
        const frame = pending.subarray(0, frameBytes)
        pending = pending.subarray(frameBytes)
        let score = 0
        if (template) {
          let best = Number.POSITIVE_INFINITY,
            bestX = x,
            bestY = y
          // Bounded 33x33 search with sampled pixels, only on this worker thread.
          for (let dy = -16; dy <= 16; dy += 2)
            for (let dx = -16; dx <= 16; dx += 2) {
              const candidateX = x + dx,
                candidateY = y + dy
              if (
                candidateX < 0 ||
                candidateY < 0 ||
                candidateX + boxWidth > width ||
                candidateY + boxHeight > height
              )
                continue
              let error = 0,
                samples = 0
              for (let row = 0; row < boxHeight; row += 2)
                for (let col = 0; col < boxWidth; col += 2) {
                  error += Math.abs(
                    frame[(candidateY + row) * width + candidateX + col] -
                      template[row * boxWidth + col]
                  )
                  samples += 1
                }
              error /= samples
              if (error < best) {
                best = error
                bestX = candidateX
                bestY = candidateY
              }
            }
          score = best
          // Hold the last known position when appearance changes substantially.
          if (best < 60) {
            x = bestX
            y = bestY
          }
        } else {
          template = new Uint8Array(boxWidth * boxHeight)
          for (let row = 0; row < boxHeight; row += 1)
            template.set(
              frame.subarray((y + row) * width + x, (y + row) * width + x + boxWidth),
              row * boxWidth
            )
        }
        points.push({
          time: request.start + frameIndex / fps,
          x: (x + boxWidth / 2) / width,
          y: (y + boxHeight / 2) / height,
          confidence: Math.max(0, 1 - score / 80)
        })
        frameIndex += 1
        if (frameIndex % 10 === 0)
          parentPort?.postMessage({
            type: 'progress',
            progress: Math.min(0.99, frameIndex / (request.duration * fps)),
            stage: 'Tracking selected region'
          })
      }
    }
    await process.done
    if (!points.length) throw new Error('No video frames were decoded')
    const output = join(request.output, 'tracking.json')
    await atomicWrite(output, JSON.stringify({ version: 1, method: 'template', points }, null, 2))
    parentPort?.postMessage({
      type: 'result',
      files: [output],
      result: {
        frames: frameIndex,
        method: 'template',
        note: 'Tracks local appearance. Review low-confidence frames and occlusions.'
      }
    })
  } finally {
    process.child.kill('SIGKILL')
    await process.done.catch(() => undefined)
  }
}
void track().catch((error: unknown) =>
  parentPort?.postMessage({
    type: 'error',
    message: error instanceof Error ? error.message : String(error)
  })
)
