/**
 * Draft-write gate: tracks every in-flight thread draft DB write so the
 * shutdown pipeline can await the last one BEFORE the database closes.
 *
 * Without this gate, a draft commit that reaches the main process during the
 * quit grace period could still be executing on the DB worker when the
 * shutdown pipeline calls database.close(), which surfaces as a write against
 * an already-closed database. The gate turns that race into an awaited
 * handshake: the pipeline flushes pending draft writes first, then closes.
 */

const inflightDraftWrites = new Set<Promise<unknown>>()

/** Register an in-flight draft write so shutdown can await it. */
export function trackDraftWrite<T>(write: Promise<T>): Promise<T> {
  const tracked = write.then(
    () => {},
    () => {}
  )
  inflightDraftWrites.add(tracked)
  void tracked.finally(() => {
    inflightDraftWrites.delete(tracked)
  })
  return write
}

/**
 * Await every draft write that has been delivered but not yet settled. New
 * writes handed to the gate while draining are picked up too. Settled-with-
 * error writes are absorbed by the gate: a failed write must never block or
 * fail the shutdown pipeline.
 */
export async function flushDraftWrites(): Promise<void> {
  // Bounded so a pathological stream of late writes can never hold quit open;
  // the shutdown failsafe covers the rest.
  for (let round = 0; round < 100 && inflightDraftWrites.size > 0; round += 1) {
    await Promise.allSettled([...inflightDraftWrites])
  }
}

/** Test hook: whether any draft write is still in flight. */
export function hasInflightDraftWrites(): boolean {
  return inflightDraftWrites.size > 0
}
