import { posixBasename, toPosixPath } from '$shared/paths'
import { fileUrlToPath } from '$lib/mime'
import type {
  PromptAssignmentTaskReference,
  PromptAttachment,
  PromptProjectReference,
  Thread
} from '$shared/types'

/** Source thread the next prompt waits for before it starts. */
export type StartAfterSelection = Pick<Thread, 'id' | 'title'>

export function projectReferenceToken(reference: Pick<PromptProjectReference, 'path'>): string {
  return `@${reference.path}`
}

export function taskReferenceToken(
  reference: Pick<PromptAssignmentTaskReference, 'taskId'>
): string {
  return `@task:${reference.taskId}`
}

export function abbreviatedTaskTitle(title: string): string {
  return title.length > 36 ? `${title.slice(0, 35).trimEnd()}…` : title
}

export function restoredDraft(
  initialValue: string,
  initialProjectReferences: readonly PromptProjectReference[],
  initialTaskReferences: readonly PromptAssignmentTaskReference[]
): string {
  const missingTokens = [
    ...initialProjectReferences.map(projectReferenceToken),
    ...initialTaskReferences.map(taskReferenceToken)
  ].filter((token) => !initialValue.includes(token))
  // Trim trailing spaces so reference tokens aren't glued to them, but keep
  // any trailing newlines the user typed so the draft round-trips exactly.
  return [initialValue.replace(/[ \t]+$/u, ''), ...missingTokens].filter(Boolean).join(' ')
}

/**
 * Identity of the file an attachment points at. The attachment chips and the
 * preview cache are keyed by the attachment's `file://` URL, so one file must
 * always produce one identity: the URL is decoded back to its path (a legacy
 * draft can hold a differently escaped URL for the same file) and folded to
 * lower case where the filesystem itself resolves `index.html` and
 * `Index.html` to a single file (macOS, and Windows where the drive letter's
 * case depends on the drag source).
 */
export function attachmentFileIdentity(file: PromptAttachment): string {
  const path = toPosixPath(fileUrlToPath(file.url))
  const platform = window.api?.windowInfo?.platform
  return platform === 'darwin' || platform === 'win32' ? path.toLowerCase() : path
}

/** Drop repeats of one file from an ordered list, keeping the first entry. */
export function uniqueAttachments(files: readonly PromptAttachment[]): PromptAttachment[] {
  const kept: PromptAttachment[] = []
  const identities: string[] = []
  for (const file of files) {
    const identity = attachmentFileIdentity(file)
    if (identities.includes(identity)) continue
    identities.push(identity)
    kept.push(file)
  }
  return kept
}

/**
 * Split incoming files into the ones worth attaching and the repeats of files
 * the composer already holds (including repeats inside the same drop).
 */
export function partitionNewAttachments(
  existing: readonly PromptAttachment[],
  incoming: readonly PromptAttachment[]
): { added: PromptAttachment[]; duplicates: PromptAttachment[] } {
  const identities = existing.map((file) => attachmentFileIdentity(file))
  const added: PromptAttachment[] = []
  const duplicates: PromptAttachment[] = []
  for (const file of incoming) {
    const identity = attachmentFileIdentity(file)
    if (identities.includes(identity)) {
      duplicates.push(file)
      continue
    }
    identities.push(identity)
    added.push(file)
  }
  return { added, duplicates }
}

export function isImageAttachment(file: PromptAttachment): boolean {
  if (file.mime.startsWith('image/')) return true
  return /\.(png|jpe?g|gif|webp|bmp|avif|svg|ico)$/iu.test(file.filename ?? '')
}

export function isEditablePastedTextAttachment(file: PromptAttachment): boolean {
  if (file.mime !== 'text/plain') return false
  const path = fileUrlToPath(file.url)
  return /^pasted-[0-9a-f-]+\.txt$/u.test(posixBasename(path))
}
