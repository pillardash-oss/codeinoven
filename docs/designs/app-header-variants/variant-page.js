(function () {

/* A variant screen: one layout, four window geometries, the states that actually
   stress it.
 *
 * Every page carries `data-variant` (v1..v6) and optional `data-options` on its
 * body, so the markup here is written once and each screen stays a paragraph of
 * its own argument. */

const PLATFORMS = ['mac', 'win', 'linux-left', 'linux-right']

const STATES = [
  {
    id: 'thread',
    title: 'Thread open, agent working',
    note: 'Spec available, git chip live, three notification dots.',
    options: {}
  },
  {
    id: 'idle',
    title: 'Thread open, idle',
    note: 'Same bar with the working badge gone. The title is the only thing that carries state.',
    options: { working: false, dots: false }
  },
  {
    id: 'long',
    title: 'Long thread title',
    note: 'A real thread name, truncated rather than allowed to push the actions.',
    options: { title: 'Remove the duplicate window controls inset from fullscreen dialogs' }
  },
  {
    id: 'empty',
    title: 'No thread selected',
    note: 'The view name only. The bar should not look broken when half of it has nothing to say.',
    options: { empty: true }
  }
]

function framesForState(variant, options) {
  const host = document.createElement('div')
  host.className = 'frames'
  if (options.empty) {
    host.innerHTML = PLATFORMS.map((platform) =>
      window.CIOHeader.block({ platform, variant, options: { empty: true } })
    ).join('')
    return host
  }
  host.innerHTML = PLATFORMS.map((platform) =>
    window.CIOHeader.block({ platform, variant, options })
  ).join('')
  return host
}

function framesForWidths(variant, options) {
  const host = document.createElement('div')
  host.className = 'frames'
  host.innerHTML = [
    window.CIOHeader.block({ platform: 'mac', variant, options }),
    window.CIOHeader.block({ platform: 'win', variant, options }),
    window.CIOHeader.block({ platform: 'linux-left', variant, options }),
    window.CIOHeader.block({ platform: 'mac', variant, width: 'narrow', options })
  ].join('')
  return host
}

function rulerStrip() {
  const host = document.createElement('div')
  host.className = 'notes'
  host.innerHTML = PLATFORMS.map(
    (platform) => `<div class="note-block"><b>${platformLabel(platform)}</b>${window.CIOHeader.rulerMarkup(platform)}</div>`
  ).join('')
  return host
}

/* The two menus V8's icon opens, as the panels the app already draws. */
function menuPanel(kind) {
  const items =
    kind === 'project'
      ? [
          ['Open project', 'quiet'],
          ['Pin to top', ''],
          ['Project settings', ''],
          ['Reveal in Finder', ''],
          ['Copy project path', 'quiet']
        ]
      : [
          ['Rename thread', ''],
          ['Pin thread', ''],
          ['Fork thread', ''],
          ['Open notes', ''],
          ['Copy thread ID', 'quiet'],
          ['Delete thread', 'danger']
        ]
  return `<div class="menu-pop demo" role="menu">${items
    .map(([label, tone]) => `<div class="item ${tone}" role="menuitem">${label}</div>`)
    .join('')}</div>`
}

/* The panel the bar is measured against, driven by the reader: the range is the
   app's own sidebar range, 200 to 420px, and the panel can be hidden, which is
   the state the app spends most of its time in when a view has no sidebar. */
const PANEL_MIN = 200
const PANEL_MAX = 420
const PANEL_START = 264

function livePanel(variant, options) {
  const stage = document.createElement('div')
  stage.className = 'panel-stage'

  const requested = new URLSearchParams(location.search).get('panel')
  const asked = requested === null ? PANEL_START : Number(requested)
  let hidden = asked === 0
  let width = hidden
    ? PANEL_START
    : Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(Number.isFinite(asked) ? asked : PANEL_START)))

  stage.innerHTML = `<div class="panel-controls"><label for="panel-size">Thread panel</label><input id="panel-size" type="range" min="${PANEL_MIN}" max="${PANEL_MAX}" step="2" value="${width}" /><output id="panel-size-value">${width}px</output><button type="button" class="panel-toggle" id="panel-toggle" aria-pressed="${hidden}">${
    hidden ? 'Show panel' : 'Hide panel'
  }</button><span class="panel-state" id="panel-size-state"></span></div><div class="panel-windows" id="panel-size-windows"></div>`

  const input = stage.querySelector('#panel-size')
  const toggle = stage.querySelector('#panel-toggle')
  const output = stage.querySelector('#panel-size-value')
  const state = stage.querySelector('#panel-size-state')
  const windows = stage.querySelector('#panel-size-windows')

  function barsMarkup(currentWidth, isHidden) {
    const frameOptions = isHidden ? { panelHidden: true } : { panelWidth: currentWidth }
    return (
      window.CIOHeader.block({ platform: 'mac', variant, options: { ...options, ...frameOptions } }) +
      window.CIOHeader.block({ platform: 'win', variant, options: { ...options, ...frameOptions } })
    )
  }

  function identityOf(windowElement) {
    const names = [...windowElement.querySelectorAll('.brand-name')]
    const name = names.find((item) => item.getBoundingClientRect().width > 0)
    if (!name) return 'mark only'
    const shown = Math.round(name.getBoundingClientRect().width)
    return `${name.textContent} at ${shown}px`
  }

  function describe() {
    const bars = [...windows.querySelectorAll('.window')]
    const mac = bars[0] ? identityOf(bars[0]) : ''
    const win = bars[1] ? identityOf(bars[1]) : ''
    return `<strong>macOS</strong> ${mac} · <strong>Windows</strong> ${win}`
  }

  function measure() {
    state.innerHTML = describe()
  }

  function paintWidth(currentWidth) {
    for (const windowElement of windows.querySelectorAll('.window')) {
      windowElement.style.setProperty('--panel-width', `${hidden ? 0 : currentWidth}px`)
    }
    output.textContent = hidden ? 'hidden' : `${currentWidth}px`
    input.disabled = hidden
    toggle.textContent = hidden ? 'Show panel' : 'Hide panel'
    toggle.setAttribute('aria-pressed', String(hidden))
    measure()
  }

  function paintHidden(isHidden) {
    hidden = isHidden
    windows.innerHTML = barsMarkup(width, hidden)
    paintWidth(width)
  }

  input.addEventListener('input', () => {
    width = Number(input.value)
    paintWidth(width)
  })

  toggle.addEventListener('click', () => paintHidden(!hidden))

  windows.innerHTML = barsMarkup(width, hidden)
  paintWidth(width)
  /* The first read has to wait for the stage to be in the document: measured
     while detached, every box is zero and the strip would claim the identity is
     gone at every width. */
  requestAnimationFrame(measure)
  return stage
}

function platformLabel(platform) {
  return {
    mac: 'macOS',
    win: 'Windows',
    'linux-left': 'Linux, left',
    'linux-right': 'Linux, right'
  }[platform]
}

function build() {
  const variant = document.body.dataset.variant
  if (!variant) return
  const options = {}

  const widths = document.querySelector('#widths')
  if (widths) widths.replaceWith(framesForWidths(variant, options))

  /* The spine's promise: the column holds its width whatever the view registers
     as its actions, so the title starts on the same pixel for one action, two
     or three. Rendered as its own frames so the claim is visible rather than
     asserted. */
  const held = document.querySelector('#held')
  if (held) {
    const host = document.createElement('div')
    host.className = 'frames'
    host.innerHTML = [
      window.CIOHeader.block({ platform: 'mac', variant, options: { ...options, actionCount: 1 } }),
      window.CIOHeader.block({ platform: 'mac', variant, options: { ...options, actionCount: 3 } }),
      window.CIOHeader.block({
        platform: 'mac',
        variant,
        options: { ...options, actionCount: 1, working: false, dots: false }
      }),
      window.CIOHeader.block({ platform: 'win', variant, options: { ...options, actionCount: 1 } }),
      window.CIOHeader.block({ platform: 'win', variant, options: { ...options, actionCount: 3 } })
    ].join('')
    held.replaceWith(host)
  }

  const statesHost = document.querySelector('#states')
  if (statesHost) {
    for (const state of STATES) {
      const section = document.createElement('section')
      section.className = 'section'
      section.innerHTML = `<div class="section-head"><h2>${state.title}</h2><span class="meta">${
        state.id
      }</span></div><p class="lede">${state.note}</p>`
      section.append(framesForState(variant, { ...options, ...state.options }))
      statesHost.append(section)
    }
  }

  /* V8's own section: the two menus the icon owns, drawn at the window height
     they actually occupy. */
  const menus = document.querySelector('#menus')
  if (menus) {
    const host = document.createElement('div')
    host.className = 'frames'
    host.innerHTML = [
      window.CIOHeader.block({ platform: 'mac', variant, options: { withRail: true } })
    ].join('')
    host.innerHTML += `<div class="frame-block"><div class="frame-label"><b>Left click</b><span class="note">the project's own dropdown</span></div><div class="frame os-mac variant-v8 menu-demo">${menuPanel('project')}</div></div>`
    host.innerHTML += `<div class="frame-block"><div class="frame-label"><b>Right click</b><span class="note">the thread's actions, where the ellipsis used to be</span></div><div class="frame os-mac variant-v8 menu-demo">${menuPanel('thread')}</div></div>`
    menus.replaceWith(host)
  }

  /* V8's core argument: the bar's leading cluster is the thread panel, so the
     rule between chrome and title is the panel's edge, and the wordmark is what
     gives way when the panel narrows. */

  const ladder = document.querySelector('#ladder')
  if (ladder) {
    const host = document.createElement('div')
    host.className = 'frames'
    const states = [
      { panelHidden: true },
      { panelHidden: true, compactActions: true },
      { panelWidth: 200 },
      { panelWidth: 264 },
      { panelWidth: 320 },
      { panelWidth: 420 }
    ]
    host.innerHTML = states
      .map((state) =>
        ['mac', 'win']
          .map((platform) => window.CIOHeader.block({ platform, variant, options: { ...options, ...state } }))
          .join('')
      )
      .join('')
    ladder.replaceWith(host)
  }

  const panel = document.querySelector('#panel')
  if (panel) panel.replaceWith(livePanel(variant, options))

  const rulers = document.querySelector('#rulers')
  if (rulers) rulers.replaceWith(rulerStrip())
}

window.CIOHeader.themeToggle()
build()
})()
