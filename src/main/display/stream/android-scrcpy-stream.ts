import { spawn, type ChildProcess } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { randomInt } from 'node:crypto'
import type {
  StreamControlMessage,
  StreamKeyMessage,
  StreamOutbound,
  StreamPointerMessage,
  StreamScrollMessage,
  StreamTextMessage
} from '../../../lib/display-stream-protocol'
import { ANDROID_INPUT_KEY_CODES, ANDROID_KEY_CODES } from '../display-adb'
import { captureCommand, captureText } from '../display-exec'
import { avcCodecString, concatBytes } from './h264-annexb'
import {
  ANDROID_ACTION_DOWN,
  ANDROID_ACTION_MOVE,
  ANDROID_ACTION_UP,
  SCRCPY_VERSION,
  ScrcpyVideoParser,
  encodeKeycode,
  encodeScroll,
  encodeText,
  encodeTouch,
  type ScrcpyVideoEvent
} from './scrcpy-protocol'

/** Where the server jar lives on the device while a stream runs. */
const REMOTE_SERVER = `/data/local/tmp/cio-scrcpy-server-${SCRCPY_VERSION}.jar`
const ADB_STEP_TIMEOUT_MS = 15_000
/** The server needs a moment to bind its socket after `app_process` starts. */
const CONNECT_ATTEMPTS = 60
const CONNECT_RETRY_MS = 100
const VIDEO_BIT_RATE = 8_000_000
const MAX_FPS = 60
/** The last of the server's own output, kept to say why a stream died. */
const SERVER_TAIL_BYTES = 2_000

export interface AndroidStreamOptions {
  adb: string
  serial: string
  /** The bundled `scrcpy-server` file. */
  serverPath: string
  maxSize: number
  send: (message: StreamOutbound) => void
}

/**
 * A copy that owns its whole `ArrayBuffer`.
 *
 * A socket read is a Node `Buffer`, and `Buffer.slice` is a view onto the same
 * memory (often a shared pool), so its `.buffer` is far larger than the frame.
 * A message carries the entire buffer, so a view here sends the decoder garbage.
 */
function ownedCopy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * One live H.264 stream of an Android device, and the touch channel back into it.
 *
 * The scrcpy server runs on the device (`app_process`), reached through an adb
 * forward. The video socket is parsed straight into stream messages; the control
 * socket takes pointer, key and text events as they happen. Nothing here decodes a
 * frame: the bytes the device's hardware encoder produced are the bytes the
 * renderer's decoder reads.
 */
export class AndroidScrcpyStream {
  private server: ChildProcess | null = null
  private video: Socket | null = null
  private control: Socket | null = null
  private forwardPort: number | null = null
  private stopped = false
  private serverTail = ''
  private size = { width: 0, height: 0 }
  private configPacket: Uint8Array | null = null
  private live = false
  private touching = false
  private lastPoint = { x: 0, y: 0 }
  private readonly parser = new ScrcpyVideoParser()

  constructor(private readonly options: AndroidStreamOptions) {}

  /** Bring the stream up. Resolves once the sockets are open, rejects with the reason it could not. */
  async start(): Promise<void> {
    const { adb, serial, serverPath } = this.options
    const scid = randomInt(1, 0x7fffffff).toString(16).padStart(8, '0')
    await captureCommand(
      adb,
      ['-s', serial, 'push', serverPath, REMOTE_SERVER],
      ADB_STEP_TIMEOUT_MS
    ).promise
    if (this.stopped) return
    const forwarded = await captureText(
      adb,
      ['-s', serial, 'forward', 'tcp:0', `localabstract:scrcpy_${scid}`],
      ADB_STEP_TIMEOUT_MS
    )
    const port = Number.parseInt(forwarded.trim(), 10)
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`adb did not report a forwarded port (${forwarded.trim() || 'no output'})`)
    }
    this.forwardPort = port
    if (this.stopped) return
    this.launchServer(scid)
    const first = await this.openVideo(port)
    if (this.stopped) return
    this.control = await this.openControl(port)
    if (this.stopped) return
    // The first bytes are handled before the socket is allowed to deliver more, so
    // the stream is always read in the order the device wrote it.
    this.handleVideo(first)
    this.video?.on('data', (data: Buffer) => this.handleVideo(data))
    this.video?.resume()
  }

  /** Tear everything down. Safe to call twice, and from any state. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.video?.destroy()
    this.control?.destroy()
    this.video = null
    this.control = null
    this.server?.kill()
    this.server = null
    const port = this.forwardPort
    this.forwardPort = null
    if (port !== null) {
      // Fire and forget: the forward is only a local port, and a failure to remove
      // it is repaired by the next `adb kill-server`.
      void captureCommand(
        this.options.adb,
        ['-s', this.options.serial, 'forward', '--remove', `tcp:${port}`],
        ADB_STEP_TIMEOUT_MS
      ).promise.catch(() => undefined)
    }
  }

  pointer(message: StreamPointerMessage): void {
    if (!this.control || this.size.width === 0) return
    const { width, height } = this.size
    const x = Math.min(width - 1, Math.max(0, message.x * width))
    const y = Math.min(height - 1, Math.max(0, message.y * height))
    if (message.action === 'down') {
      this.touching = true
      this.lastPoint = { x, y }
      this.control.write(encodeTouch(ANDROID_ACTION_DOWN, x, y, width, height))
      return
    }
    if (!this.touching) return
    if (message.action === 'move') {
      this.lastPoint = { x, y }
      this.control.write(encodeTouch(ANDROID_ACTION_MOVE, x, y, width, height))
      return
    }
    this.touching = false
    // A cancelled gesture ends where the finger last was: the server has no cancel.
    const end = message.action === 'up' ? { x, y } : this.lastPoint
    this.control.write(encodeTouch(ANDROID_ACTION_UP, end.x, end.y, width, height))
  }

  key(message: StreamKeyMessage): void {
    this.press(ANDROID_INPUT_KEY_CODES[message.key])
  }

  text(message: StreamTextMessage): void {
    this.control?.write(encodeText(message.text))
  }

  scroll(message: StreamScrollMessage): void {
    if (!this.control || this.size.width === 0) return
    const { width, height } = this.size
    this.control.write(
      encodeScroll(
        Math.min(width - 1, message.x * width),
        Math.min(height - 1, message.y * height),
        width,
        height,
        message.dx,
        message.dy
      )
    )
  }

  controlButton(message: StreamControlMessage): void {
    const code = ANDROID_KEY_CODES[message.action]
    if (code !== undefined) this.press(code)
  }

  private press(code: number): void {
    if (!this.control) return
    this.control.write(encodeKeycode(ANDROID_ACTION_DOWN, code))
    this.control.write(encodeKeycode(ANDROID_ACTION_UP, code))
  }

  private launchServer(scid: string): void {
    const { adb, serial, maxSize } = this.options
    const args = [
      '-s',
      serial,
      'shell',
      `CLASSPATH=${REMOTE_SERVER}`,
      'app_process',
      '/',
      'com.genymobile.scrcpy.Server',
      SCRCPY_VERSION,
      `scid=${scid}`,
      'log_level=warn',
      'tunnel_forward=true',
      'audio=false',
      'control=true',
      'video_codec=h264',
      `max_size=${Math.max(0, Math.round(maxSize))}`,
      `max_fps=${MAX_FPS}`,
      `video_bit_rate=${VIDEO_BIT_RATE}`,
      'send_device_meta=false',
      'clipboard_autosync=false',
      'cleanup=true'
    ]
    const child = spawn(adb, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const remember = (chunk: Buffer): void => {
      this.serverTail = (this.serverTail + chunk.toString('utf8')).slice(-SERVER_TAIL_BYTES)
    }
    child.stdout?.on('data', remember)
    child.stderr?.on('data', remember)
    child.once('error', (error) => this.end(error.message))
    child.once('exit', (code) => {
      if (this.stopped) return
      this.end(this.serverTail.trim() || `The device server exited with code ${code}`)
    })
    this.server = child
  }

  /** Connect the video socket; the first byte it yields proves the server accepted it. */
  private async openVideo(port: number): Promise<Uint8Array> {
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS && !this.stopped; attempt += 1) {
      try {
        const { socket, first } = await this.connectOnce(port)
        this.video = socket
        socket.once('close', () => this.end('The video connection closed'))
        return first
      } catch {
        await delay(CONNECT_RETRY_MS)
      }
    }
    throw new Error(this.serverTail.trim() || 'The device server did not start in time')
  }

  private connectOnce(port: number): Promise<{ socket: Socket; first: Buffer }> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port })
      socket.setNoDelay(true)
      const fail = (): void => {
        socket.destroy()
        reject(new Error('not accepted yet'))
      }
      socket.once('error', fail)
      socket.once('close', fail)
      socket.once('data', (first: Buffer) => {
        socket.removeListener('error', fail)
        socket.removeListener('close', fail)
        socket.pause()
        resolve({ socket, first })
      })
    })
  }

  private openControl(port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port }, () => resolve(socket))
      socket.setNoDelay(true)
      // The server also writes device messages (clipboard) here; nothing reads them.
      socket.on('data', () => undefined)
      socket.once('error', reject)
      socket.once('close', () => this.end('The control connection closed'))
    })
  }

  private handleVideo(data: Uint8Array): void {
    if (this.stopped) return
    let events: ScrcpyVideoEvent[]
    try {
      events = this.parser.push(data)
    } catch (error) {
      this.end(error instanceof Error ? error.message : String(error))
      return
    }
    for (const event of events) {
      if (event.type === 'session') {
        this.size = { width: event.width, height: event.height }
        continue
      }
      if (event.config) {
        this.configPacket = ownedCopy(event.data)
        const codec = avcCodecString(this.configPacket)
        if (!codec) {
          this.end('The device encoder sent no usable H.264 parameters')
          return
        }
        this.options.send({
          type: 'config',
          codec,
          width: this.size.width,
          height: this.size.height
        })
        if (!this.live) {
          this.live = true
          this.options.send({ type: 'state', phase: 'live' })
        }
        continue
      }
      if (!this.configPacket) continue
      const payload = event.key ? concatBytes(this.configPacket, event.data) : ownedCopy(event.data)
      this.options.send({
        type: 'chunk',
        key: event.key,
        timestampUs: event.ptsUs,
        data: payload.buffer
      })
    }
  }

  /** The stream is over, for a reason worth telling the panel. */
  private end(detail: string): void {
    if (this.stopped) return
    this.options.send({ type: 'state', phase: 'ended', detail })
    this.stop()
  }
}
