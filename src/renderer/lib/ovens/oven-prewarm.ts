import { invoke } from '$lib/ipc.svelte'
import { LOCAL_OVEN_ID } from '$shared/ovens'

/** The only part of a thread this needs, so a caller can pass what it has. */
interface OvenThreadLike {
  settings?: { ovenId?: string } | null
}

/**
 * Open a thread's Oven session before the user asks it for anything.
 *
 * Opening a chat is the earliest moment the app knows which machine the work
 * belongs to, and every surface that follows on mount (file tree, Git status,
 * composer, the conversation itself) reads through that session. Starting it
 * here means those reads cost a round trip instead of a remote process start,
 * which is the difference between a chat that is ready and one that stalls for
 * seconds on its first paint.
 *
 * Deliberately fire and forget: opening a thread must never wait for a network
 * handshake, and a session that cannot start is retried by the first request
 * that needs it.
 */
export function prewarmThreadOven(thread: OvenThreadLike | null | undefined): void {
  const ovenId = thread?.settings?.ovenId
  if (!ovenId || ovenId === LOCAL_OVEN_ID) return
  void invoke('oven:warm', ovenId)
}
