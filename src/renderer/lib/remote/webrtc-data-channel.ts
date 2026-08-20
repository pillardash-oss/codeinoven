export interface WebRtcSessionDescription {
  type: 'offer' | 'answer'
  sdp: string
}

export interface BrowserWebRtcChannelOptions {
  iceServers: RTCIceServer[]
  onOffer: (description: WebRtcSessionDescription) => void
  onMessage: (data: string) => void
  onStateChange: (state: 'connecting' | 'open' | 'closed' | 'failed') => void
}

const ICE_GATHER_TIMEOUT_MS = 8_000

/** Browser-native WebRTC offerer used by the installed PWA. */
export class BrowserWebRtcChannel {
  private peer: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null

  constructor(private readonly options: BrowserWebRtcChannelOptions) {}

  get open(): boolean {
    return this.channel?.readyState === 'open'
  }

  async start(): Promise<void> {
    this.close()
    this.options.onStateChange('connecting')
    const peer = new RTCPeerConnection({ iceServers: this.options.iceServers })
    this.peer = peer
    const channel = peer.createDataChannel('codeinoven-rpc', { ordered: true })
    this.channel = channel
    channel.onopen = () => {
      if (this.channel === channel) this.options.onStateChange('open')
    }
    channel.onclose = () => {
      if (this.channel === channel) this.options.onStateChange('closed')
    }
    channel.onmessage = (event) => {
      if (this.channel === channel && typeof event.data === 'string') {
        this.options.onMessage(event.data)
      }
    }
    peer.onconnectionstatechange = () => {
      if (this.peer !== peer) return
      if (peer.connectionState === 'failed') this.options.onStateChange('failed')
      if (peer.connectionState === 'closed' || peer.connectionState === 'disconnected') {
        this.options.onStateChange('closed')
      }
    }
    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    await this.waitForIceGathering(peer)
    const local = peer.localDescription
    if (!local?.sdp) throw new Error('WebRTC offer was not created')
    this.options.onOffer({ type: 'offer', sdp: local.sdp })
  }

  async acceptAnswer(answer: WebRtcSessionDescription): Promise<void> {
    if (!this.peer) return
    await this.peer.setRemoteDescription(answer)
  }

  send(data: string): boolean {
    if (!this.open || !this.channel) return false
    this.channel.send(data)
    return true
  }

  close(): void {
    this.channel?.close()
    this.channel = null
    this.peer?.close()
    this.peer = null
  }

  private waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
    if (peer.iceGatheringState === 'complete') return Promise.resolve()
    return new Promise((resolve) => {
      const finish = (): void => {
        window.clearTimeout(timer)
        peer.removeEventListener('icegatheringstatechange', onChange)
        resolve()
      }
      const onChange = (): void => {
        if (peer.iceGatheringState === 'complete') finish()
      }
      const timer = window.setTimeout(finish, ICE_GATHER_TIMEOUT_MS)
      peer.addEventListener('icegatheringstatechange', onChange)
    })
  }
}
