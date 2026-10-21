/**
 * Giving the Oven's daemon a name a person can find on Windows.
 *
 * The daemon is a Node process, so Task Manager lists it as `node`, with Node's
 * own description and icon, beside every other Node program on the machine. A
 * person who wants to free their machine, or stop an Oven that is working, has to
 * guess which of those entries is ours: the scheduler's task name is visible only
 * in Task Scheduler, and the Oven is a scheduled task rather than a Windows
 * service, so the Services list never mentions it at all.
 *
 * The runtime is therefore linked under this app's name in the Oven data root and
 * started through that path, which is what Task Manager displays. A hard link is
 * the first choice because it costs no disk and can never drift from the runtime
 * the machine's Node actually is; a copy keeps the name on a filesystem that
 * refuses links, and failing both leaves the plain runtime path rather than a
 * daemon that will not start.
 *
 * The icon stays the runtime's own: changing it would mean shipping a signed
 * binary of ours, and a renamed copy of Node is not that.
 *
 * This module is free of Electron and of process control.
 */
import { copyFile, link, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** The executable name an Oven's daemon carries in the Windows process list. */
export const WINDOWS_OVEN_EXECUTABLE = 'codeinoven-oven connect.exe'

/**
 * The runtime path the launcher should use, named for this app when it can be.
 *
 * Re-linking happens only when the name no longer points at the same file, so a
 * Node upgrade on the Oven is picked up and a steady machine pays nothing.
 */
export async function prepareOvenExecutable(nodePath: string, root: string): Promise<string> {
  // Only Windows shows a process by the path that started it in this way, and only
  // Windows needs the name to stand out from a shared system runtime.
  if (process.platform !== 'win32') return nodePath
  const target = join(root, WINDOWS_OVEN_EXECUTABLE)
  try {
    const source = await stat(nodePath)
    const existing = await stat(target).catch(() => null)
    if (existing && existing.ino === source.ino && existing.dev === source.dev) return target
    await mkdir(root, { recursive: true })
    await rm(target, { force: true })
    try {
      await link(nodePath, target)
    } catch {
      await copyFile(nodePath, target)
    }
    return target
  } catch {
    // A machine that refuses both leaves an Oven that starts, unnamed in the list,
    // which is exactly the behaviour before this existed.
    return nodePath
  }
}
