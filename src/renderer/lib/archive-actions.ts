import { invoke } from '$lib/ipc.svelte'
import { appConfirm } from '$lib/stores/app-confirm.svelte'
import type { ArchiveKind } from '$shared/archives'
import { toast } from 'svelte-sonner'

/**
 * What each kind of archive hides, in the user's terms.
 *
 * Archiving never destroys anything, so every one of these says where the item
 * goes and how to get it back: the prompt is a deliberate step, not a warning
 * about loss.
 */
const ARCHIVE_COPY: Record<ArchiveKind, (name: string) => { body: string; note: string }> = {
  project: (name) => ({
    body: `"${name}" and its threads leave the sidebar and stop running scheduled work. Nothing is deleted, and no file on disk is touched.`,
    note: 'Restore it any time from Settings > Archives.'
  }),
  thread: (name) => ({
    body: `"${name}" leaves the sidebar and its thread search, and stops running work. Nothing is deleted.`,
    note: 'Restore it any time from Settings > Archives.'
  }),
  assistant: (name) => ({
    body: `"${name}" and its threads leave the sidebar, and its schedule stops running. Nothing is deleted.`,
    note: 'Restore it any time from Settings > Archives.'
  })
}

const ARCHIVE_TITLE: Record<ArchiveKind, string> = {
  project: 'Archive this project?',
  thread: 'Archive this thread?',
  assistant: 'Archive this assistant?'
}

/**
 * Archive one item after the user confirms it.
 *
 * Every archive entry point routes through here, because archiving is a
 * deliberate action rather than something to discover by clicking: a mistyped
 * click would otherwise hide a project, a thread, or an assistant's schedule
 * with nothing on screen to explain where it went.
 */
export async function archiveItem(kind: ArchiveKind, id: string, name: string): Promise<void> {
  const copy = ARCHIVE_COPY[kind](name)
  const approved = await appConfirm.request({
    title: ARCHIVE_TITLE[kind],
    body: [copy.body],
    note: copy.note,
    confirmLabel: 'Archive',
    tone: 'primary'
  })
  if (!approved) return
  try {
    await invoke('archive:set', kind, id, true)
    toast.success('Archived. Restore it from Settings > Archives.')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Could not archive this item')
  }
}
