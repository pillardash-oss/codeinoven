/**
 * Device readings for the admission policy.
 *
 * The sampler is a background service, so it follows the app's rule for one: it
 * only runs while somebody is asking. The first read primes a short CPU delta and
 * starts a one second loop that fills a five sample window, and thirty seconds
 * after the last read the loop stops and everything it held is dropped. No
 * consumer, no timer.
 *
 * CPU comes from `os.cpus()` deltas rather than a load average, because a load
 * average is a minute of history and the question here is "is there room right
 * now". Memory is what the machine can actually hand out: `MemAvailable` on
 * Linux, and free plus inactive, speculative and purgeable pages on macOS. The
 * raw free-page count is far too small to judge a healthy Mac by (a 16 GB machine
 * idling at 56 MB free still has about 2.9 GB available), and reading it made the
 * gate hold work on a machine with plenty of room.
 */
import { cpus, freemem, totalmem } from 'node:os'
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app } from 'electron'
import { decideAdmission, type AdmissionDecision } from '../../lib/resource-admission'
import { Logger } from './logger'

/** How long the first read waits before it has one CPU delta to average. */
const PRIME_WINDOW_MS = 250
/** How often the armed sampler takes a CPU reading. */
const SAMPLE_INTERVAL_MS = 1_000
/** How many readings the window averages over, which is the five second span. */
const WINDOW_SAMPLES = 5
/** How long an armed sampler stays alive after the last read. */
const IDLE_DISARM_MS = 30_000

interface CpuSnapshot {
  idle: number
  total: number
}

interface SystemMemoryInfo {
  total: number
  free: number
}

function cpuSnapshot(): CpuSnapshot {
  let idle = 0
  let total = 0
  for (const cpu of cpus()) {
    const times = cpu.times
    idle += times.idle
    total += times.user + times.nice + times.sys + times.idle + times.irq
  }
  return { idle, total }
}

/** Idle share of the CPU time between two snapshots, or null when nothing elapsed. */
function idlePercent(previous: CpuSnapshot, next: CpuSnapshot): number | null {
  const total = next.total - previous.total
  if (total <= 0) return null
  return ((next.idle - previous.idle) / total) * 100
}

/** Available memory in bytes, or null when the platform cannot answer. */
function readableSystemMemory(): SystemMemoryInfo | null {
  const reader = (process as NodeJS.Process & { getSystemMemoryInfo?: () => SystemMemoryInfo })
    .getSystemMemoryInfo
  if (typeof reader !== 'function') return null
  try {
    const info = reader.call(process)
    if (!info || !Number.isFinite(info.free) || !Number.isFinite(info.total)) return null
    return info
  } catch (error) {
    Logger.dev('Resource pressure: system memory reading failed', error)
    return null
  }
}

/**
 * Bytes macOS says can be handed out, from `vm_stat`.
 *
 * Free pages alone are not availability: the kernel keeps most idle memory in
 * inactive, speculative and purgeable pages, which it reclaims on demand. The
 * page size is printed in the same output, so nothing has to assume 4 KB pages
 * on Apple silicon.
 */
export function darwinAvailableBytes(vmStat: string): number | null {
  const pageSize = /page size of (\d+) bytes/u.exec(vmStat)
  if (!pageSize) return null
  const size = Number(pageSize[1])
  if (!Number.isFinite(size) || size <= 0) return null
  const pages = (label: string): number => {
    const match = new RegExp(`^${label}:\\s+(\\d+)\\.`, 'mu').exec(vmStat)
    return match ? Number(match[1]) : 0
  }
  const availablePages =
    pages('Pages free') +
    pages('Pages inactive') +
    pages('Pages speculative') +
    pages('Pages purgeable')
  return Math.max(0, availablePages * size)
}

/** Bytes Linux says can be handed out, from `/proc/meminfo`'s `MemAvailable`. */
export function linuxAvailableBytes(meminfo: string): number | null {
  const match = /^MemAvailable:\s+(\d+) kB$/mu.exec(meminfo)
  if (!match) return null
  return Math.max(0, Number(match[1]) * 1024)
}

/** Longest the darwin read waits for `vm_stat` before it is treated as no answer. */
const VM_STAT_TIMEOUT_MS = 1_000

const execFileAsync = promisify(execFile)

/** What the platform reports as available, or null when nothing can be read.
 *
 * The darwin read spawns a child process, so it is asynchronous: `vm_stat` on a
 * busy machine can take longer than the answer is worth, and this sampler runs
 * on the Electron main thread, where a synchronous spawn froze the UI. A
 * failure or a timeout is one caught rejection, never a rejected sampler. The
 * Linux read stays synchronous: `/proc/meminfo` is a small in-memory file whose
 * read is cheaper than the promise that would wrap it.
 */
async function platformAvailableBytes(): Promise<number | null> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('/usr/bin/vm_stat', {
        encoding: 'utf8',
        timeout: VM_STAT_TIMEOUT_MS
      })
      return darwinAvailableBytes(stdout)
    }
    if (process.platform === 'linux') {
      return linuxAvailableBytes(readFileSync('/proc/meminfo', 'utf8'))
    }
  } catch (error) {
    Logger.dev('Resource pressure: available memory reading failed', error)
  }
  return null
}

/** Bytes new work can use, falling back to raw free memory when nothing answers. */
async function availableMemoryBytes(): Promise<number> {
  const available = await platformAvailableBytes()
  if (available !== null) return available
  const info = readableSystemMemory()
  if (info) return Math.max(0, info.free * 1024)
  return Math.max(0, freemem())
}

function totalMemoryBytes(): number {
  const info = readableSystemMemory()
  if (info) return Math.max(0, info.total * 1024)
  return Math.max(0, totalmem())
}

/**
 * The preset a dev probe asked for, or null to read the real device.
 *
 * `CIO_FORCE_ADMISSION_FILE` names a file whose contents are read on every
 * sample, so a probe can move the machine from short to roomy mid-run and watch
 * the five second recheck release the message. `CIO_FORCE_ADMISSION` is the
 * fixed form. `app.isPackaged` keeps both out of a shipped build.
 */
function forcedPreset(): string | null {
  if (app.isPackaged) return null
  const path = process.env['CIO_FORCE_ADMISSION_FILE']?.trim()
  if (path) {
    try {
      const value = readFileSync(path, 'utf8').trim()
      if (value === 'queue' || value === 'offload' || value === 'proceed') return value
    } catch {
      // A missing or unreadable file means no forcing, never a stuck queue.
    }
  }
  const fixed = process.env['CIO_FORCE_ADMISSION']?.trim()
  return fixed === 'queue' || fixed === 'offload' || fixed === 'proceed' ? fixed : null
}

/**
 * A dev probe can force the answer, so the waiting card can be exercised without
 * starving the machine it runs on. The sample behind each preset is a fixed one,
 * so the numbers the card shows are the numbers the policy was given.
 */
function forcedDecision(): AdmissionDecision | null {
  const forced = forcedPreset()
  if (forced === null) return null
  const gigabyte = 1024 ** 3
  if (forced === 'queue') {
    return decideAdmission({
      cpuAvailablePercent: 1,
      memoryAvailableBytes: 0.2 * gigabyte,
      totalMemoryBytes: 32 * gigabyte
    })
  }
  if (forced === 'offload') {
    return decideAdmission({
      cpuAvailablePercent: 1,
      memoryAvailableBytes: 6 * gigabyte,
      totalMemoryBytes: 32 * gigabyte
    })
  }
  return decideAdmission({
    cpuAvailablePercent: 50,
    memoryAvailableBytes: 6 * gigabyte,
    totalMemoryBytes: 32 * gigabyte
  })
}

class ResourcePressureSampler {
  #previous: CpuSnapshot | null = null
  #window: number[] = []
  #ticker: NodeJS.Timeout | null = null
  #idleTimer: NodeJS.Timeout | null = null
  #priming: Promise<void> | null = null

  /** Read the device. Arms the sampler, and answers from the current window. */
  async read(): Promise<AdmissionDecision> {
    const forced = forcedDecision()
    if (forced !== null) return forced
    if (this.#window.length === 0) await this.#prime()
    this.#armIdleDisarm()
    return decideAdmission({
      cpuAvailablePercent: this.#averageIdlePercent(),
      memoryAvailableBytes: await availableMemoryBytes(),
      totalMemoryBytes: totalMemoryBytes()
    })
  }

  #averageIdlePercent(): number {
    if (this.#window.length === 0) return 100
    let sum = 0
    for (const value of this.#window) sum += value
    return sum / this.#window.length
  }

  /** One short delta so the first answer has a reading behind it. */
  #prime(): Promise<void> {
    this.#priming ??= (async () => {
      const previous = cpuSnapshot()
      await new Promise((resolve) => setTimeout(resolve, PRIME_WINDOW_MS))
      const next = cpuSnapshot()
      this.#push(idlePercent(previous, next))
      this.#previous = next
      this.#startTicker()
    })().finally(() => {
      this.#priming = null
    })
    return this.#priming
  }

  #startTicker(): void {
    if (this.#ticker) return
    this.#ticker = setInterval(() => this.#sample(), SAMPLE_INTERVAL_MS)
    this.#ticker.unref()
  }

  #sample(): void {
    const next = cpuSnapshot()
    if (this.#previous) this.#push(idlePercent(this.#previous, next))
    this.#previous = next
  }

  #push(value: number | null): void {
    if (value === null || !Number.isFinite(value)) return
    this.#window.push(Math.min(100, Math.max(0, value)))
    while (this.#window.length > WINDOW_SAMPLES) this.#window.shift()
  }

  #armIdleDisarm(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleTimer = setTimeout(() => this.#disarm(), IDLE_DISARM_MS)
    this.#idleTimer.unref()
  }

  /** No reads for a while: stop the loop and drop every reading it held. */
  #disarm(): void {
    if (this.#ticker) clearInterval(this.#ticker)
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#ticker = null
    this.#idleTimer = null
    this.#previous = null
    this.#window = []
    this.#priming = null
  }
}

export const resourcePressure = new ResourcePressureSampler()
