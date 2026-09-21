import { spawn } from 'node:child_process'
import { resolvePackageCommand } from '../drivers/cli-environment'

/** Hard ceiling on one Skills CLI run, so a stalled clone cannot hang the app. */
const SKILLS_CLI_TIMEOUT_MS = 180_000

/** Keeps the tail of the CLI output, which is where its errors and summary land. */
const SKILLS_CLI_OUTPUT_LIMIT = 200_000

/**
 * Runs the Skills CLI (`skills`) through whichever package manager the machine
 * has, from `cwd`. The CLI owns the on-disk skill layout, so both install and
 * uninstall go through it instead of hand-rolling folder surgery. A non-zero
 * exit surfaces the CLI's own output, which is the only diagnostic it gives.
 */
export function runSkillsCli(args: string[], cwd: string): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    const launch = resolvePackageCommand('execute', 'skills', args, {
      ...process.env,
      DISABLE_TELEMETRY: '1',
      DO_NOT_TRACK: '1'
    })
    const child = spawn(launch.command, launch.args, {
      cwd,
      env: launch.env,
      shell: launch.shell,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const append = (chunk: Buffer): void => {
      output = `${output}${chunk.toString('utf-8')}`.slice(-SKILLS_CLI_OUTPUT_LIMIT)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timeout = setTimeout(() => child.kill('SIGTERM'), SKILLS_CLI_TIMEOUT_MS)
    child.once('error', (error) => {
      clearTimeout(timeout)
      rejectRun(error)
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolveRun(output.trim())
      else rejectRun(new Error(output.trim() || `Skills CLI exited with code ${code ?? -1}`))
    })
  })
}
