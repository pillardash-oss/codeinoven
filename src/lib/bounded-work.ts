/** Share a concurrency limit across callers, including work that outlives a UI deadline. */
export function createWorkQueue(concurrency: number, capacity = 128) {
  let active = 0
  const waiting: Array<() => void> = []
  return async function run<T>(work: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      if (waiting.length >= capacity) throw new Error('Background work queue is full')
      await new Promise<void>((resolve) => waiting.push(resolve))
    } else active += 1
    try {
      return await work()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active -= 1
    }
  }
}

/** Publish small batches and yield before the next one, including cached results. */
export async function mapInBatches<T, R>(
  items: readonly T[],
  size: number,
  work: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  for (let offset = 0; offset < items.length; offset += size) {
    results.push(
      ...(await Promise.all(
        items.slice(offset, offset + size).map((item, index) => work(item, offset + index))
      ))
    )
    if (offset + size < items.length) await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  return results
}
