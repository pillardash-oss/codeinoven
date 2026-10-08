interface HarnessGate {
  mutationRequests: number
  pendingStarts: number
}

const gates = new Map<string, HarnessGate>()
const mutationQueues = new Map<string, Promise<void>>()

function keyFor(ovenId: string, command: string): string {
  return `${ovenId}\0${command}`
}

function gateFor(key: string): HarnessGate {
  let gate = gates.get(key)
  if (!gate) {
    gate = { mutationRequests: 0, pendingStarts: 0 }
    gates.set(key, gate)
  }
  return gate
}

/** Reserve the short interval in which a new remote run is admitted. */
export function beginOvenHarnessRun(ovenId: string, command: string): () => void {
  const gate = gateFor(keyFor(ovenId, command))
  if (gate.mutationRequests > 0)
    throw new Error('This harness is being updated on the Oven. Try starting the run again shortly.')
  gate.pendingStarts++
  let released = false
  return () => {
    if (released) return
    released = true
    gate.pendingStarts = Math.max(0, gate.pendingStarts - 1)
  }
}

/** Block new runs while one update or uninstall waits for existing runs to finish. */
export async function withOvenHarnessMutation<T>(
  ovenId: string,
  command: string,
  task: () => Promise<T>
): Promise<T> {
  const key = keyFor(ovenId, command)
  const gate = gateFor(key)
  gate.mutationRequests++
  const previous = mutationQueues.get(key) ?? Promise.resolve()
  let releaseQueue = (): void => undefined
  const queued = new Promise<void>((resolve) => {
    releaseQueue = resolve
  })
  mutationQueues.set(key, previous.catch(() => undefined).then(() => queued))
  await previous.catch(() => undefined)

  try {
    while (gate.pendingStarts > 0) await new Promise((resolve) => setTimeout(resolve, 25))
    return await task()
  } finally {
    gate.mutationRequests = Math.max(0, gate.mutationRequests - 1)
    releaseQueue()
    const tail = mutationQueues.get(key)
    if (tail) {
      void tail.then(() => {
        if (mutationQueues.get(key) === tail) mutationQueues.delete(key)
        if (gate.mutationRequests === 0 && gate.pendingStarts === 0 && !mutationQueues.has(key))
          gates.delete(key)
      })
    }
  }
}
