import type { RTCDataChannel, RTCIceServer, RTCPeerConnection } from 'werift'
import { Logger } from '../system/logger'

export interface WebRtcSessionDescription {
  type: 'offer' | 'answer'
  sdp: string
}

export interface DesktopWebRtcChannelOptions {
  onMessage: (data: string) => void
  onStateChange: (state: 'connecting' | 'open' | 'closed' | 'failed') => void
}

/** WebRTC answerer owned by Electron main; the browser/PWA is the offerer. */
export class DesktopWebRtcChannel {
  private peer: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null

  constructor(private readonly options: DesktopWebRtcChannelOptions) {}

  get open(): boolean {
    return this.channel?.readyState === 'open'
  }

  async acceptOffer(
    offer: WebRtcSessionDescription,
    iceServers: RTCIceServer[]
  ): Promise<WebRtcSessionDescription> {
    await this.close()
    this.options.onStateChange('connecting')
    const { RTCPeerConnection: RTCPeerConnectionCtor } = await import('werift')
    const peer = new RTCPeerConnectionCtor({ iceServers })
    this.peer = peer
    peer.connectionStateChange.subscribe((state) => {
      if (this.peer !== peer) return
      if (state === 'failed') this.options.onStateChange('failed')
      if (state === 'closed' || state === 'disconnected') this.options.onStateChange('closed')
    })
    peer.onDataChannel.subscribe((channel) => this.bindChannel(peer, channel))
    await peer.setRemoteDescription(offer)
    const answer = await peer.createAnswer()
    await peer.setLocalDescription(answer)
    const local = peer.localDescription
    if (!local) throw new Error('WebRTC answer was not created')
    return { type: 'answer', sdp: local.sdp }
  }

  send(data: string): boolean {
    if (!this.open || !this.channel) return false
    this.channel.send(data)
    return true
  }

  async close(): Promise<void> {
    const peer = this.peer
    this.peer = null
    this.channel?.close()
    this.channel = null
    if (peer) await peer.close().catch(() => undefined)
  }

  private bindChannel(peer: RTCPeerConnection, channel: RTCDataChannel): void {
    if (this.peer !== peer || channel.label !== 'codeinoven-rpc') {
      channel.close()
      return
    }
    this.channel = channel
    channel.stateChanged.subscribe((state) => {
      if (this.channel !== channel) return
      if (state === 'open') {
        Logger.dev('Remote WebRTC data channel connected')
        this.options.onStateChange('open')
      } else if (state === 'closed') {
        this.options.onStateChange('closed')
      }
    })
    channel.onMessage.subscribe((data) => {
      if (this.channel !== channel) return
      this.options.onMessage(typeof data === 'string' ? data : data.toString('utf8'))
    })
  }
}
