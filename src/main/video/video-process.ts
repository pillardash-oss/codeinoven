import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { buildProcessEnvironment } from '../drivers/cli-environment'
import { resolveFfmpegPath } from '../speech/ffmpeg-path'

export interface VideoProcess {
  child: ChildProcessWithoutNullStreams
  done: Promise<string>
}
/** Two codec threads, one filter thread, bounded diagnostics and a hard deadline. */
export async function startVideoProcess(
  args: string[],
  cwd: string,
  signal: AbortSignal
): Promise<VideoProcess> {
  signal.throwIfAborted()
  const child = spawn(
    await resolveFfmpegPath(),
    [
      '-hide_banner',
      '-nostdin',
      '-threads',
      '2',
      '-filter_threads',
      '1',
      '-filter_complex_threads',
      '1',
      ...args
    ],
    {
      cwd,
      env: buildProcessEnvironment(),
      stdio: 'pipe',
      windowsHide: true
    }
  )
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-32768)
  })
  child.stdin.on('error', () => undefined)
  const kill = (): void => {
    child.kill('SIGKILL')
  }
  const timer = setTimeout(kill, 30 * 60 * 1000)
  signal.addEventListener('abort', kill, { once: true })
  if (signal.aborted) kill()
  const done = new Promise<string>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', kill)
      if (signal.aborted) reject(new Error('Video job cancelled'))
      else if (code !== 0) reject(new Error(`Media processing failed: ${stderr.slice(-3000)}`))
      else resolve(stderr)
    })
  })
  void done.catch(() => undefined)
  return { child, done }
}
export async function videoProcess(
  args: string[],
  cwd: string,
  signal: AbortSignal
): Promise<string> {
  const task = await startVideoProcess(args, cwd, signal)
  task.child.stdout.resume()
  task.child.stdin.end()
  return task.done
}
