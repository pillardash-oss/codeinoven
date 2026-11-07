import { describe, expect, it } from 'vitest'
import {
  DISCOVERED_STATE_WAIT_MS,
  MAX_DISCOVERED_STATES_PER_SCREEN,
  planScreenCanvas,
  readScreenCanvasMetadata,
  withDiscoveredStates
} from '../../src/lib/design/screen-canvas'

/**
 * A discovered state is a frame of the screen that declares it.
 *
 * The merge is what keeps the canvas honest: a state a person declared in
 * `canvas.json` is not shown twice, a state of a screen the folder no longer holds
 * is dropped with that screen, and a frame keeps its screen's own width so a state
 * is compared against the layout it belongs to.
 */

function plan(frames: Record<string, unknown>[] = []) {
  return planScreenCanvas({
    screens: [{ entry: 'index.html', name: 'Index' }],
    metadata: readScreenCanvasMetadata({ frames })
  })
}

describe('discovered states on the canvas', () => {
  it('frames a discovered state right after its screen, inheriting its size', () => {
    const base = plan([{ entry: 'index.html', title: 'Home', width: 390 }])
    const merged = withDiscoveredStates(base, [
      { entry: 'index.html', click: 'button#open', title: 'Settings' }
    ])
    expect(merged.frames).toHaveLength(2)
    expect(merged.frames[0]?.entry).toBe('index.html')
    expect(merged.frames[1]).toEqual({
      entry: 'index.html',
      title: 'Settings',
      caption: null,
      width: 390,
      height: null,
      state: {
        click: 'button#open',
        focus: null,
        scroll: null,
        hash: null,
        search: null,
        wait: DISCOVERED_STATE_WAIT_MS
      }
    })
  })

  it('does not frame a state the design already declared', () => {
    const base = plan([
      {
        entry: 'index.html',
        title: 'Settings open',
        state: { click: 'button#open' }
      }
    ])
    const merged = withDiscoveredStates(base, [
      { entry: 'index.html', click: 'button#open', title: 'Settings' }
    ])
    expect(merged.frames).toHaveLength(1)
    expect(merged.frames[0]?.title).toBe('Settings open')
  })

  it('drops the state of a screen the canvas does not frame', () => {
    const base = plan([{ entry: 'index.html' }])
    const merged = withDiscoveredStates(base, [
      { entry: 'pages/gone.html', click: 'button#open', title: 'Gone' }
    ])
    expect(merged.frames).toHaveLength(1)
  })

  it('caps the states one screen contributes', () => {
    const base = plan([{ entry: 'index.html' }])
    const merged = withDiscoveredStates(
      base,
      Array.from({ length: 20 }, (_, index) => ({
        entry: 'index.html',
        click: `button#open-${index}`,
        title: `State ${index}`
      }))
    )
    expect(merged.frames).toHaveLength(1 + MAX_DISCOVERED_STATES_PER_SCREEN)
  })
})
