/**
 * DECSCUSR (DEC cursor shape) decoding for the embedded ghostty-web terminal.
 *
 * Applications like Neovim switch cursor shape by emitting "CSI Ps SP q" on
 * mode changes (e.g. a wide block in normal mode, a slim bar in insert mode).
 * ghostty-web renders a fixed `cursorStyle` option and never applies these, so
 * we parse the PTY output stream here and push shape + blink changes into the
 * renderer. The decoder is a small state machine so sequences split across
 * chunks (or inside OSC/DCS payloads) are handled safely.
 */

export type TerminalCursorStyle = 'block' | 'underline' | 'bar'

export interface CursorShape {
  style: TerminalCursorStyle
  blinking: boolean
}

const ESC = 0x1b
const CSI = 0x5b
const BEL = 0x07

/** Match the app's default cursor (bar + blink) used for "restore default". */
const DEFAULT_SHAPE: CursorShape = { style: 'bar', blinking: true }

type DecoderState =
  | { kind: 'idle' }
  | { kind: 'esc' }
  | { kind: 'csi'; params: string }
  | { kind: 'skip' }

function shapeForCode(code: number): CursorShape {
  switch (code) {
    case 0:
      return { ...DEFAULT_SHAPE }
    case 1:
      return { style: 'block', blinking: true }
    case 2:
      return { style: 'block', blinking: false }
    case 3:
      return { style: 'underline', blinking: true }
    case 4:
      return { style: 'underline', blinking: false }
    case 5:
      return { style: 'bar', blinking: true }
    case 6:
      return { style: 'bar', blinking: false }
    default:
      return { ...DEFAULT_SHAPE }
  }
}

export class CursorShapeDecoder {
  private state: DecoderState = { kind: 'idle' }

  /**
   * Feed a chunk of PTY output. Returns a cursor shape whenever a DECSCUSR
   * sequence completes, otherwise `null`.
   */
  push(data: string): CursorShape | null {
    let shape: CursorShape | null = null
    for (let i = 0; i < data.length; i += 1) {
      const byte = data.charCodeAt(i)
      if (this.state.kind === 'idle') {
        if (byte === ESC) this.state = { kind: 'esc' }
        continue
      }
      if (this.state.kind === 'esc') {
        if (byte === CSI) {
          this.state = { kind: 'csi', params: '' }
        } else if (byte === 0x5d || byte === 0x50 || byte === 0x58 || byte === 0x5e || byte === 0x5f) {
          // OSC (' ] ') and DCS/APC/PM ('P', 'X', '^', '_'): skip payloads.
          this.state = { kind: 'skip' }
        } else {
          this.state = { kind: 'idle' }
        }
        continue
      }
      if (this.state.kind === 'csi') {
        if (byte >= 0x20 && byte <= 0x3f) {
          this.state = { kind: 'csi', params: this.state.params + data[i] }
        } else if (byte >= 0x40 && byte <= 0x7e) {
          const detected = this.finalize(this.state.params, data[i])
          if (detected) shape = detected
          this.state = { kind: 'idle' }
        } else {
          this.state = { kind: 'idle' }
        }
        continue
      }
      // skip (OSC/DCS/APC/PM): terminated by BEL or ST (ESC \)
      if (byte === BEL) {
        this.state = { kind: 'idle' }
      } else if (byte === ESC) {
        this.state = { kind: 'esc' }
      }
    }
    return shape
  }

  private finalize(params: string, finalByte: string): CursorShape | null {
    if (finalByte !== 'q') return null
    const code = Number(params.replace(/ /g, ''))
    if (!Number.isInteger(code) || code < 0 || code > 6) return null
    return shapeForCode(code)
  }
}
