import * as pty from 'node-pty'
import { stripVTControlCharacters } from 'node:util'

interface ParentPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}
interface TrustLaunch {
  type: 'start'
  executable: string
  args: string[]
  env: Record<string, string>
  cwd: string
}
const parent = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
let terminal: pty.IPty | undefined
let output = ''
let asked = false
let approved = false
let finished = false

function finish(error?: string): void {
  if (finished) return
  finished = true
  terminal?.kill()
  parent?.postMessage(error ? { type: 'error', message: error } : { type: 'done' })
}

parent?.on('message', ({ data }: { data: unknown }) => {
  if (!data || typeof data !== 'object' || !('type' in data)) return
  if (data.type === 'answer' && 'approved' in data) {
    if (!asked || finished) return
    if (data.approved !== true) {
      terminal?.write('no\r')
      finish('The SSH host fingerprint was not accepted.')
    } else {
      approved = true
      terminal?.write('yes\r')
    }
    return
  }
  if (data.type === 'cancel') {
    finish('Connection test cancelled.')
    return
  }
  if (data.type !== 'start' || terminal) return
  const launch = data as TrustLaunch
  try {
    terminal = pty.spawn(launch.executable, launch.args, {
      name: 'xterm',
      cols: 160,
      rows: 24,
      cwd: launch.cwd,
      env: launch.env
    })
    terminal.onData((chunk) => {
      output = (output + stripVTControlCharacters(chunk)).slice(-8192)
      if (
        /REMOTE HOST IDENTIFICATION HAS CHANGED|REVOKED HOST KEY|Host key verification failed/u.test(
          output
        )
      ) {
        finish('The SSH host key changed or was revoked. Verify it before updating OpenSSH trust.')
        return
      }
      if (!asked && /\(yes\/no(?:\/\[fingerprint\])?\)\?\s*$/u.test(output)) {
        const start = output.lastIndexOf('The authenticity of host ')
        const prompt = output.slice(Math.max(0, start)).trim()
        if (!/SHA256:[A-Za-z0-9+/]+/u.test(prompt)) {
          finish('OpenSSH did not provide a host fingerprint to verify.')
          return
        }
        asked = true
        parent?.postMessage({ type: 'prompt', prompt: prompt.slice(0, 4096) })
      }
    })
    terminal.onExit(() => {
      terminal = undefined
      // Authentication is deliberately disabled. Only the strict retry proves
      // the host was trusted and the real account can authenticate.
      if (asked && !approved) finish('The SSH host fingerprint was not accepted.')
      else finish()
    })
  } catch {
    finish('Could not open the OpenSSH host verification session.')
  }
})
