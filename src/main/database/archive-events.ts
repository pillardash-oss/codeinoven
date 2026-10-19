import type { ArchiveKind } from '../../lib/archives'
import { Logger } from '../system/logger'

type ArchiveListener = (kind: ArchiveKind, id: string, archived: boolean) => Promise<void> | void
const listeners = new Set<ArchiveListener>()

export function subscribeArchiveChanges(listener: ArchiveListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export async function emitArchiveChange(
  kind: ArchiveKind,
  id: string,
  archived: boolean
): Promise<void> {
  for (const listener of listeners) {
    try {
      await listener(kind, id, archived)
    } catch (error) {
      Logger.error('Archive visibility refresh failed', error)
    }
  }
}
