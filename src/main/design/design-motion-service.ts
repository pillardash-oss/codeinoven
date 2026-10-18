/// <reference types="electron-vite/node" />
import createTargetWorker from './design-motion-target-worker.ts?nodeWorker'
import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { atomicWrite } from '../../lib/utils'
import {
  authoredMotionCss,
  motionTargetId,
  validateAuthoredMotion
} from '../../lib/design/motion-policy'
import { requireLocalProjectViaWorker } from '../../lib/project-artifacts'
import {
  isInsideProject,
  resolveServedFolder,
  resolveServedEntry,
  servedFileUrl
} from '../preview/served-folder'
import { openDesignPreview } from './design-preview-session'
import { currentWorkRoot } from './work-roots-state'
import type { DesignPreviewExecutorOptions } from '../preview/design-preview-executor'

const writes = new Map<string, Promise<unknown>>()
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')

export async function executeDesignMotion(
  options: DesignPreviewExecutorOptions,
  operation: string,
  input: Record<string, unknown>,
  context: { projectId: string; threadId: string }
): Promise<unknown> {
  const project = await requireLocalProjectViaWorker(options.database, context.projectId)
  const folder = resolveServedFolder(
    project.path,
    input.directory,
    currentWorkRoot('design', context.projectId)
  )
  const root = await realpath(project.path)
  const absolute = await realpath(folder.absolute)
  if (!isInsideProject(root, absolute)) throw new Error('Motion folder escapes the project')
  const entry = await resolveServedEntry(absolute, input.entry)
  if (!entry || !/\.html?$/iu.test(entry.requested))
    throw new Error('Motion editing requires an HTML screen')
  // resolveServedEntry's default entry may be relative; canonicalize from the folder.
  const file = await realpath(resolve(absolute, ...entry.segments))
  if (!isInsideProject(absolute, file)) throw new Error('Motion screen escapes its folder')
  const read = async (): Promise<string> => {
    if ((await stat(file)).size > 512 * 1024)
      throw new Error('Motion editing accepts screens up to 512 KiB')
    return readFile(file, 'utf8')
  }
  const source = await read()
  const revision = hash(source)
  const id = operation === 'motion-inspect' ? undefined : motionTargetId(input.targetId)
  const styleRange = id
    ? await new Promise<{ start: number; end: number } | null>((resolveTarget, rejectTarget) => {
        const worker = createTargetWorker({ workerData: { source, id } })
        let settled = false
        const finish = (
          error?: Error,
          range: { start: number; end: number } | null = null
        ): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          void worker.terminate()
          if (error) rejectTarget(error)
          else resolveTarget(range)
        }
        const timer = setTimeout(() => finish(new Error('Motion target analysis timed out')), 5000)
        worker.on(
          'message',
          (message: { error?: string; styleRange?: { start: number; end: number } | null }) => {
            finish(message.error ? new Error(message.error) : undefined, message.styleRange ?? null)
          }
        )
        worker.on('error', (error: Error) => finish(error))
        worker.on('exit', () => finish(new Error('Motion target worker stopped')))
      })
    : null
  if (operation === 'motion-read')
    return {
      directory: folder.display,
      entry: entry.requested,
      targetId: id,
      revision,
      sourceStyle: styleRange ? source.slice(styleRange.start, styleRange.end) : null
    }
  if (
    operation !== 'motion-inspect' &&
    (typeof input.revision !== 'string' || input.revision !== revision)
  )
    throw new Error(
      'The screen changed. Read the motion target again before previewing or applying.'
    )
  const motion = operation === 'motion-inspect' ? undefined : validateAuthoredMotion(input.motion)
  if (operation === 'motion-apply' && id && motion) {
    const previous = writes.get(file) ?? Promise.resolve()
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        if (hash(await read()) !== revision)
          throw new Error('The screen changed. Read the motion target again.')
        await options.checkpoint(context.projectId, context.threadId, {
          directory: folder.display,
          entry: entry.requested,
          label: `Before motion on ${id}`
        })
        const current = await read()
        if (hash(current) !== revision)
          throw new Error('The screen changed during checkpointing. Read the target again.')
        const block = `<style data-cio-motion="${id}">${authoredMotionCss(id, motion)}</style>`
        const next = styleRange
          ? current.slice(0, styleRange.start) + block + current.slice(styleRange.end)
          : current + '\n' + block + '\n'

        await atomicWrite(file, next)
        let checkpointError: string | undefined
        try {
          await options.checkpoint(context.projectId, context.threadId, {
            directory: folder.display,
            entry: entry.requested,
            label: `Motion on ${id}`
          })
        } catch (error) {
          checkpointError = error instanceof Error ? error.message : String(error)
        }
        return {
          applied: true,
          directory: folder.display,
          entry: entry.requested,
          targetId: id,
          revision: hash(next),
          motion,
          ...(checkpointError ? { checkpointError } : {})
        }
      })
    writes.set(file, task)
    try {
      return await task
    } finally {
      if (writes.get(file) === task) writes.delete(file)
    }
  }
  const browser = options.browser()
  if (!browser) throw new Error('Motion observation needs the in-app browser')
  const registration = await options.previews.open(absolute)
  const url = servedFileUrl(registration.url, entry)
  const existing = browser.designMotionTab(context.projectId, context.threadId, url)
  const preview = existing
    ? { tabId: existing, url }
    : await openDesignPreview(
        { previews: options.previews, browser: options.browser },
        {
          projectPath: project.path,
          ...context,
          directory: folder.display,
          entry: entry.requested,
          defaultRoot: currentWorkRoot('design', context.projectId),
          attention: 'background',
          reveal: false,
          tab: 'thread'
        }
      )
  if (!preview.tabId) throw new Error('The motion preview could not open')
  await browser.waitForTabLoad(preview.tabId)
  const sampleMs = input.sampleMs ?? 250
  if (typeof sampleMs !== 'number' || !Number.isFinite(sampleMs) || sampleMs < 0 || sampleMs > 2000)
    throw new Error('sampleMs must be between 0 and 2000')
  const observed = await browser.inspectDesignMotion(preview.tabId, preview.url, {
    targetId: id,
    motion,
    sampleMs
  })
  if (hash(await read()) !== revision)
    throw new Error('The source changed during observation. Repeat on the current revision.')
  return { directory: folder.display, entry: entry.requested, revision, observed }
}
