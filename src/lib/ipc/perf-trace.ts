import type { PerfMemoryReport } from '../perf-trace'
import type { Contract } from './contract-helpers'

/**
 * The renderer's performance-record channel.
 *
 * A batch, not a stream: the renderer holds its records and hands them over on a
 * short timer, so one click that produces forty measurements costs one send
 * instead of forty. The batch is a `send` rather than an `invoke` on purpose —
 * a measurement must never be able to make its own send wait on an answer, and
 * the renderer has nothing to do with the reply.
 */
export const PERF_RECORDS_SEND_CHANNEL = 'perf:records'

export const invokePerfTraceContract = {
  /**
   * The app's live memory footprint, read on request.
   *
   * The periodic sample already lands in the trace, but an investigation needs
   * to be able to ask *right now* — while a thread is open and the app is
   * crawling — instead of waiting for the next tick and hoping it caught the
   * moment.
   */
  'perf:memory': {} as Contract<[], PerfMemoryReport>,
  /**
   * Write whatever the trace sink is still holding.
   *
   * Quitting, and any investigation that wants a trace truncated exactly at the
   * moment of interest, needs a way to force the queued records out.
   */
  'perf:flush': {} as Contract<[], void>
}
