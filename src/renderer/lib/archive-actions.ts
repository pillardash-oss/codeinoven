import { invoke } from '$lib/ipc.svelte'
import type { ArchiveKind } from '$shared/archives'
import { toast } from 'svelte-sonner'

export async function archiveItem(kind: ArchiveKind, id: string): Promise<void> {
  try {
    await invoke('archive:set', kind, id, true)
    toast.success('Archived. Restore it from Settings > Archives.')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Could not archive this item')
  }
}
