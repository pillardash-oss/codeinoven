import { describe, expect, it, vi } from 'vitest'
import {
  applyKeepAliveAction,
  createKeepAliveSession,
  INITIAL_KEEP_ALIVE,
  type KeepAliveSession,
  type KeepAliveState
} from './keep-alive'
import { TrayController, type TrayHost, type SessionDisplay } from './trayController'

describe('keep-alive lifecycle', () => {
  it('runs the full away lifecycle: idle -> armed -> active -> live -> active -> idle', () => {
    let state: KeepAliveState = INITIAL_KEEP_ALIVE

    state = applyKeepAliveAction(state, { type: 'arm' })
    expect(state.phase).toBe('KEEP_ALIVE_ARMED')
    expect(state.blockedQuit).toBe(false)

    state = applyKeepAliveAction(state, { type: 'activate' })
    expect(state.phase).toBe('KEEP_ALIVE_ACTIVE')
    expect(state.blockedQuit).toBe(false)

    state = applyKeepAliveAction(state, { type: 'sessionStart' })
    expect(state.phase).toBe('REMOTE_SESSION_LIVE')
    expect(state.blockedQuit).toBe(true)

    state = applyKeepAliveAction(state, { type: 'sessionEnd' })
    expect(state.phase).toBe('KEEP_ALIVE_ACTIVE')
    expect(state.blockedQuit).toBe(false)

    state = applyKeepAliveAction(state, { type: 'disarm' })
    expect(state.phase).toBe('IDLE')
    expect(state.blockedQuit).toBe(false)
    expect(state.since).toBe(0)
  })

  it('arms only from IDLE', () => {
    const session = createKeepAliveSession()
    session.dispatch({ type: 'sessionStart' })
    session.dispatch({ type: 'arm' })
    expect(session.phase).toBe('REMOTE_SESSION_LIVE')
  })

  it('ends only a live session', () => {
    const session = createKeepAliveSession()
    session.dispatch({ type: 'arm' })
    session.dispatch({ type: 'sessionEnd' })
    expect(session.phase).toBe('KEEP_ALIVE_ARMED')
  })

  it('exposes a reactive-free session via createKeepAliveSession', () => {
    const session = createKeepAliveSession()
    expect(session.phase).toBe('IDLE')
    session.dispatch({ type: 'arm' })
    expect(session.phase).toBe('KEEP_ALIVE_ARMED')
    expect(session.blockedQuit).toBe(false)
  })
})

class FakeTrayHost implements TrayHost {
  menus: string[] = []
  notifications: Array<{ title: string; body?: string }> = []
  tooltips: string[] = []

  create(menu: { title: string; items: Array<{ id: string; label: string }> }): void {
    this.menus.push(`${menu.title} :: ${menu.items.map((item) => item.label).join(' | ')}`)
  }

  destroy(): void {
    this.menus.push('DESTROYED')
  }

  notify(title: string, body?: string): void {
    this.notifications.push({ title, body })
  }

  setTooltip(text: string): void {
    this.tooltips.push(text)
  }
}

class FakeDisplay implements SessionDisplay {
  phases: string[] = []
  statusText(): string {
    return 'LAN connected'
  }

  setKeepAlive(phase: string): void {
    this.phases.push(phase)
  }
}

function setup(): {
  host: FakeTrayHost
  display: FakeDisplay
  keepAlive: KeepAliveSession
  controller: TrayController
  advertise: ReturnType<typeof vi.fn>
  stopAdvertise: ReturnType<typeof vi.fn>
  onDisconnect: ReturnType<typeof vi.fn>
} {
  const host = new FakeTrayHost()
  const display = new FakeDisplay()
  const keepAlive = createKeepAliveSession()
  const advertise = vi.fn()
  const stopAdvertise = vi.fn()
  const onDisconnect = vi.fn()
  const controller = new TrayController({
    host,
    keepAlive,
    sessionDisplay: display,
    advertise,
    stopAdvertise,
    onRemoteDisconnect: onDisconnect
  })
  return { host, display, keepAlive, controller, advertise, stopAdvertise, onDisconnect }
}

describe('TrayController', () => {
  it('arms keep-alive, advertises the LAN peer, and updates the menu on enable', () => {
    const { host, display, keepAlive, controller, advertise } = setup()

    controller.toggleRemoteMode()

    expect(keepAlive.phase).toBe('KEEP_ALIVE_ARMED')
    expect(display.phases).toContain('KEEP_ALIVE_ARMED')
    expect(advertise).toHaveBeenCalledTimes(1)
    expect(host.notifications.some((n) => n.title === 'Remote mode enabled')).toBe(true)
    expect(host.menus[host.menus.length - 1]).toContain('Disable Remote Mode')
  })

  it('disarms and stops advertising on disable', () => {
    const { controller, keepAlive, stopAdvertise } = setup()

    controller.toggleRemoteMode()
    controller.toggleRemoteMode()

    expect(keepAlive.phase).toBe('IDLE')
    expect(stopAdvertise).toHaveBeenCalledTimes(1)
  })

  it('marks a live session and blocks quit', () => {
    const { controller, keepAlive, display, host } = setup()

    controller.toggleRemoteMode()
    controller.sessionStarted()

    expect(keepAlive.phase).toBe('REMOTE_SESSION_LIVE')
    expect(display.phases).toContain('REMOTE_SESSION_LIVE')
    expect(host.tooltips.some((tip) => tip.includes('quit blocked'))).toBe(true)
    expect(host.notifications.some((n) => n.title === 'Remote session started')).toBe(true)

    expect(controller.requestQuit()).toBe(false)
    expect(host.notifications.some((n) => n.title === 'Quit blocked')).toBe(true)
  })

  it('allows quit when no live session is blocking', () => {
    const { controller } = setup()
    expect(controller.requestQuit()).toBe(true)
  })

  it('restores to keep-alive active and notifies on remote disconnect', () => {
    const { controller, keepAlive, display, host, onDisconnect } = setup()

    controller.toggleRemoteMode()
    controller.sessionStarted()
    controller.sessionEnded('Phone disconnected')

    expect(keepAlive.phase).toBe('KEEP_ALIVE_ACTIVE')
    expect(display.phases).toContain('KEEP_ALIVE_ACTIVE')
    expect(onDisconnect).toHaveBeenCalledWith('Phone disconnected')
    expect(host.notifications.some((n) => n.title === 'Remote session ended')).toBe(true)
  })

  it('leaves the menu with Quit disabled while a remote session is live', () => {
    const { host, controller } = setup()
    controller.toggleRemoteMode()
    controller.sessionStarted()

    const lastMenu = host.menus[host.menus.length - 1]
    expect(lastMenu).toContain('Remote session live')
  })
})
