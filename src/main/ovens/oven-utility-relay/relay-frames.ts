import { Buffer } from 'node:buffer'
import type {
  OvenUtilityJson,
  OvenUtilityRelayCommand,
  OvenUtilityRelayEvent
} from '../../../lib/oven-utility-host'

/**
 * The largest single frame either direction may carry.
 *
 * Mirrors `MAX_RESPONSE_BYTES` in `oven-request-channel.ts` for the same reason:
 * one wedged peer must not grow this app's memory without limit. A frame that
 * big is a defect on the other side, never a normal answer, so it is refused
 * instead of buffered to the end.
 */
export const MAX_RELAY_FRAME_BYTES = 8 * 1024 * 1024

/**
 * A frame the relay contract cannot carry.
 *
 * Both directions share it: a frame that arrives past the size bound, or one
 * that is not a relay event, leaves the relay with no way to answer, so the
 * caller ends that relay and reports this message.
 */
export class RelayFrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RelayFrameError'
  }
}

function tooLarge(bytes: number): RelayFrameError {
  const limit = MAX_RELAY_FRAME_BYTES / 1024 / 1024
  return new RelayFrameError(
    `The Oven utility relay sent a ${(bytes / 1024 / 1024).toFixed(1)} MiB frame, past the ${limit} MiB limit for one frame.`
  )
}

/**
 * Split a relay's stdout into whole frames.
 *
 * A frame is one JSON line, and a chunk of a pipe ends wherever the transport
 * felt like ending it, including in the middle of a multi-byte character. The
 * pieces are therefore kept as text and joined only when the newline that ends
 * the frame arrives: joining on every chunk would make one large frame cost
 * quadratic memory, which is the same reason the request channel buffers parts.
 */
export class RelayFrameReader {
  /** Chunks of one frame that has not reached its newline yet. */
  private parts: string[] = []
  /** Bytes buffered in `parts`, so a huge frame is refused instead of kept. */
  private bytes = 0

  /** The frames this chunk completed, in arrival order. */
  push(text: string): string[] {
    const frames: string[] = []
    let rest = text
    for (;;) {
      const end = rest.indexOf('\n')
      if (end < 0) {
        if (!rest) return frames
        this.parts.push(rest)
        this.bytes += Buffer.byteLength(rest)
        if (this.bytes > MAX_RELAY_FRAME_BYTES) {
          this.reset()
          throw tooLarge(this.bytes)
        }
        return frames
      }
      const head = rest.slice(0, end)
      const buffered = this.bytes + Buffer.byteLength(head)
      if (buffered > MAX_RELAY_FRAME_BYTES) {
        this.reset()
        throw tooLarge(buffered)
      }
      const line = (this.parts.length > 0 ? `${this.parts.join('')}${head}` : head).trim()
      this.reset()
      rest = rest.slice(end + 1)
      if (line) frames.push(line)
    }
  }

  /** Forget a half-read frame, as the reader does when its relay is over. */
  reset(): void {
    this.parts.length = 0
    this.bytes = 0
  }
}

/**
 * The JSON a gateway route receives, exactly as it crossed the frame.
 *
 * The frame was parsed from JSON a moment ago, so this is a shape assertion
 * rather than a conversion: a caller could not have sent anything else.
 */
function asUtilityJson(value: unknown): OvenUtilityJson {
  return value === undefined ? null : (value as OvenUtilityJson)
}

/**
 * One route's result as a frame value.
 *
 * The result crosses a process boundary, so it has to be JSON *now* rather than
 * whenever a socket happens to serialize it: a cyclic value or a `BigInt` would
 * otherwise fail long after the call that produced it. Round-tripping is what
 * the peer does with the frame anyway, and it fails here, where the answer
 * frame can still report the reason.
 */
export function utilityJsonValue(value: unknown): OvenUtilityJson {
  const text = JSON.stringify(value)
  if (text === undefined) return null
  const decoded: unknown = JSON.parse(text)
  return asUtilityJson(decoded)
}

/**
 * One command as a line of stdin.
 *
 * The size bound is enforced here as well as on arrival: a `start` frame carries
 * the turn's whole utility registry, and writing a frame the peer must refuse
 * would leave both ends waiting on a call that never arrives.
 */
export function encodeRelayCommand(command: OvenUtilityRelayCommand): string {
  const line = `${JSON.stringify(command)}\n`
  const bytes = Buffer.byteLength(line)
  if (bytes > MAX_RELAY_FRAME_BYTES) throw tooLarge(bytes)
  return line
}

/**
 * Decode one frame from an Oven's relay, refusing what this app cannot answer.
 *
 * The three event kinds are the whole contract, so anything else is a peer that
 * speaks something else: answering every `ask` and ignoring the rest would make
 * this app silently drop calls a turn is waiting on.
 */
export function parseRelayEvent(raw: string): OvenUtilityRelayEvent {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    throw new RelayFrameError('The Oven utility relay sent a frame that is not JSON.')
  }
  if (typeof decoded !== 'object' || decoded === null)
    throw new RelayFrameError('The Oven utility relay sent a frame that is not a relay event.')
  const frame = decoded as Record<string, unknown>
  switch (frame['kind']) {
    case 'ready': {
      const port = frame['port']
      const hostProtocolVersion = frame['hostProtocolVersion']
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
        throw new RelayFrameError('The Oven utility relay reported an invalid port.')
      if (typeof hostProtocolVersion !== 'number')
        throw new RelayFrameError('The Oven utility relay reported no host protocol version.')
      return { kind: 'ready', port, hostProtocolVersion }
    }
    case 'ask': {
      const id = frame['id']
      const turnId = frame['turnId']
      const route = frame['route']
      if (typeof id !== 'string' || !id || typeof route !== 'string' || !route)
        throw new RelayFrameError('The Oven utility relay sent a call with no route or no id.')
      if (typeof turnId !== 'string' || !turnId)
        throw new RelayFrameError('The Oven utility relay sent a call bound to no turn.')
      return { kind: 'ask', id, turnId, route, input: asUtilityJson(frame['input']) }
    }
    case 'failed': {
      const error = frame['error']
      return {
        kind: 'failed',
        error:
          typeof error === 'string' && error.trim().length > 0
            ? error
            : 'The Oven utility relay failed.'
      }
    }
    default:
      throw new RelayFrameError('The Oven utility relay sent a frame this app does not understand.')
  }
}
