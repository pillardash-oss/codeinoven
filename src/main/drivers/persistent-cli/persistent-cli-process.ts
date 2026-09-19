import type { ChildProcess } from 'child_process'

export function hasProcessExited(child: ChildProcess): boolean {
  return (
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  )
}

export function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasProcessExited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (exited: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      child.removeListener('close', onClose)
      resolve(exited)
    }
    const onExit = (): void => finish(true)
    const onClose = (): void => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
    child.once('close', onClose)
  })
}
