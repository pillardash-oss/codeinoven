/* One header, four window-control layouts.
 *
 * Every frame on every screen is produced here so the study compares layouts
 * rather than six hand-written bars that quietly drift apart. A caller picks a
 * platform (which decides where the OS zone sits and how wide it is), a variant
 * (which decides how the app's own controls relate to that zone), and a width.
 *
 * The OS geometry is the real thing:
 *   macOS          traffic lights inset at the left, 80px reserved
 *   Windows        caption overlay at the right, 138px reserved
 *   Linux left     gtk-decoration-layout puts the buttons at the left, 138px
 *   Linux right    the same desktop family, buttons at the right, 138px
 */

const ICONS = {
  mark: `<svg viewBox="0 0 96 96" aria-hidden="true"><path d="M49 17a31 31 0 1 0 0 62" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="square"/><path d="M61 23h23v50H61z" fill="none" stroke="currentColor" stroke-width="7" stroke-linejoin="miter"/><rect x="58" y="45" width="29" height="6" fill="currentColor"/><circle cx="84" cy="48" r="5" fill="var(--color-accent)"/></svg>`,
  back: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M9.5 3.5 5 8l4.5 4.5"/></svg>`,
  forward: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M6.5 3.5 11 8l-4.5 4.5"/></svg>`,
  search: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="7" cy="7" r="4"/><path d="m10 10 3 3"/></svg>`,
  plus: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>`,
  tools: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h6"/></svg>`,
  branch: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 3-7 2-7 5.5"/></svg>`,
  notes: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M3.5 2.5h6l3 3v8h-9z"/><path d="M9.5 2.5v3h3M5.5 8.5h5M5.5 11h3.5"/></svg>`,
  bell: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M4 6.5a4 4 0 0 1 8 0c0 3 1 4.5 1 4.5H3s1-1.5 1-4.5Z"/><path d="M6.5 13a1.5 1.5 0 0 0 3 0"/></svg>`,
  dots: `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.5" cy="8" r="1.1"/></svg>`,
  folder: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2 4.5h4l1.5 2h6.5v7H2z"/></svg>`,
  terminal: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10"/><path d="m5 6.5 2 1.75L5 10M9 10h2.5"/></svg>`,
  spec: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M3 2.5h7l3 3v8H3z"/><path d="M9.5 2.5v3.5H13M5.5 8h5M5.5 10.5h5"/></svg>`,
  minimize: `<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><path d="M2 5h6"/></svg>`,
  maximize: `<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><rect x="2.5" y="2.5" width="5" height="5"/></svg>`,
  close: `<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5"/></svg>`
}

const PLATFORMS = {
  mac: { cls: 'os-mac', brand: 'cio', zone: 'left' },
  win: { cls: 'os-win', brand: 'CodeInOven', zone: 'right' },
  'linux-left': { cls: 'os-linux-left', brand: 'CodeInOven', zone: 'left' },
  'linux-right': { cls: 'os-linux-right', brand: 'CodeInOven', zone: 'right' }
}

const LABELS = {
  mac: 'macOS',
  win: 'Windows',
  'linux-left': 'Linux, buttons left',
  'linux-right': 'Linux, buttons right'
}

const NOTES = {
  mac: 'traffic lights inset, 80px at the left',
  win: 'caption overlay, 138px at the right',
  'linux-left': 'gtk-decoration-layout: close at the left, 138px',
  'linux-right': 'gnome default: close at the right, 138px'
}

function iconButton(icon, modifier = '') {
  const base = modifier ? `ibtn ${modifier}` : 'ibtn'
  return `<button type="button" class="${base}" tabindex="-1">${ICONS[icon]}</button>`
}

function zoneMarkup(platform) {
  const config = PLATFORMS[platform]
  if (config.zone === 'right') {
    return `<div class="os-zone right"><span class="cap">${ICONS.minimize}</span><span class="cap">${ICONS.maximize}</span><span class="cap">${ICONS.close}</span></div>`
  }
  return `<div class="os-zone left"><i class="light"></i><i class="light"></i><i class="light"></i></div>`
}

function brandMarkup(platform, options = {}) {
  const config = PLATFORMS[platform]
  /* Windows and Linux have no menu bar naming the app, so the bar carries the
     wordmark there; macOS keeps the short mark beside its traffic lights. */
  const name =
    config.brand === 'CodeInOven'
      ? `<span class="wordmark">CodeInOven</span>`
      : `<span>${config.brand}</span>`
  return `<button type="button" class="brand" tabindex="-1">${ICONS.mark}${name}</button>`
}

function navigationMarkup() {
  return `${iconButton('back', 'path')}${iconButton('forward', 'dim')}`
}

function viewActionsMarkup() {
  return `<span class="slot">${iconButton('plus')}${iconButton('search')}${iconButton('tools')}</span>`
}

function threadMarkup(options = {}) {
  const status =
    options.working === false
      ? ''
      : `<span class="status"><svg viewBox="0 0 16 16" width="8" height="8" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="8" cy="8" r="5"/></svg>Working</span>`
  return `<div class="thread">${
    options.project === false ? '' : `<span class="pico">${ICONS.folder}</span>`
  }<h1>${options.title ?? 'Repair header collision under caption overlay'}</h1><button type="button" class="menu" tabindex="-1">${ICONS.dots}</button>${status}</div>`
}

function globalActionsMarkup(options = {}) {
  const dots = options.dots === false ? '' : `<span class="dots"><i></i><i class="thread"></i><i class="warn"></i></span>`
  return `<span class="slot"><span class="bell-wrap">${iconButton('notes')}</span><span class="bell-wrap">${iconButton('bell')}${dots}</span></span>`
}

function specButtonMarkup() {
  return `<button type="button" class="tbtn" tabindex="-1">${ICONS.spec}<span class="label">Spec</span></button>`
}

function gitChipMarkup() {
  return `<span class="chip">${ICONS.branch}<span>main</span><span class="lead">3</span></span>`
}

/* The fixed spine of V7: four groups, each separated by a hairline, in a column
   that does not change width when the thread title does. */
function spineMarkup(platform, options) {
  return [
    brandMarkup(platform, options),
    `<span class="hair"></span>`,
    navigationMarkup(),
    `<span class="hair"></span>`,
    viewActionsMarkup()
  ].join('')
}

function seamed(platform, content) {
  const seamSide = PLATFORMS[platform].zone
  return `${content}<span class="seam ${seamSide}"></span>`
}

function frame({ platform, variant, width = 'full', options = {} }) {
  const config = PLATFORMS[platform]
  const classes = ['frame', config.cls, `variant-${variant}`]
  if (width === 'narrow') classes.push('narrow')
  /* The optional constant gutter: the same left margin on every platform, so
     the spine and the title start on the same pixel in all four windows. */
  if (variant === 'v7' && options.hardGutter) classes.push('hard-gutter')

  const left =
    variant === 'v7'
      ? `<div class="zone left spine">${spineMarkup(platform, options)}</div>`
      : `<div class="zone left">${brandMarkup(platform, options)}${navigationMarkup()}${
          variant === 'v6' ? '' : viewActionsMarkup()
        }</div>`

  let center
  if (options.empty) {
    center = `<div class="zone center"><div class="view-name">${options.viewName ?? 'Threads'}</div></div>`
  } else if (variant === 'v4') {
    center = `<div class="zone center"><div class="cmd${width === 'narrow' ? ' narrow-hide' : ''}">${ICONS.search}<span class="placeholder">${
      options.title ?? 'Search, run a command, or open the thread'
    }</span><kbd>${platform === 'mac' ? '⌘K' : 'Ctrl K'}</kbd><span class="cmd-chip">${ICONS.spec}Spec</span><span class="cmd-chip">${ICONS.branch}3</span></div></div>`
  } else {
    center =
      variant === 'v7'
        ? `<div class="zone center"><span class="hair optional"></span>${threadMarkup(options)}</div>`
        : `<div class="zone center">${threadMarkup(options)}</div>`
  }

  let right
  if (options.empty) {
    right = `<div class="zone right">${globalActionsMarkup(options)}</div>`
  } else if (variant === 'v3') {
    right = `<div class="zone right">${globalActionsMarkup(options)}</div>`
  } else if (variant === 'v6') {
    right = `<div class="zone right"><div class="ladder">${viewActionsMarkup()}${specButtonMarkup()}${gitChipMarkup()}${globalActionsMarkup(
      options
    )}</div></div>`
  } else {
    right = `<div class="zone right"><span class="slot">${specButtonMarkup()}${gitChipMarkup()}${globalActionsMarkup(
      options
    )}</span></div>`
  }

  const body = `${zoneMarkup(platform)}${left}${center}${right}`
  const inner = variant === 'v1' ? seamed(platform, body) : body

  if (variant === 'v5') {
    return `<div class="stack${width === 'narrow' ? ' narrow' : ''}"><div class="frame ${config.cls}">${zoneMarkup(
      platform
    )}<div class="zone left">${brandMarkup(platform, options)}${navigationMarkup()}</div>${center}<div class="zone right">${globalActionsMarkup(
      options
    )}</div></div><div class="strip"><span class="tag">View</span>${viewActionsMarkup()}<span class="divider"></span>${specButtonMarkup()}${gitChipMarkup()}<span class="spacer"></span><button type="button" class="tbtn" tabindex="-1">${
      ICONS.terminal
    }<span class="label">Terminal</span></button><button type="button" class="tbtn" tabindex="-1">${
      ICONS.dots
    }<span class="label">Thread</span></button></div></div>`
  }

  return `<div class="${classes.join(' ')}">${inner}</div>`
}

function block({ platform, variant, width = 'full', options = {}, label = '' }) {
  const heading = label || `${LABELS[platform]} · ${NOTES[platform]}`
  return `<div class="frame-block"><div class="frame-label"><b>${LABELS[platform]}</b><span class="note">${
    notesFor(platform)
  }${width === 'narrow' ? ' · narrow window' : ''}</span></div>${frame({ platform, variant, width, options })}</div>`
}

function notesFor(platform) {
  return NOTES[platform]
}

function renderAll(variant, targets, options = {}) {
  return targets
    .map((target) =>
      block({ platform: target.platform, variant, width: target.width ?? 'full', options })
    )
    .join('')
}

function mount(selector, variant, targets, options = {}) {
  const host = document.querySelector(selector)
  if (host) host.innerHTML = renderAll(variant, targets, options)
}

function rulerMarkup(platform) {
  const config = PLATFORMS[platform]
  const osIsLeft = config.zone === 'left'
  const osPx = platform === 'mac' ? 80 : 138
  /* One scale for every frame: a plausible 1200px window. */
  const total = 1200
  const ours = total - osPx
  const osShare = `${(osPx / total) * 100}%`
  const ourShare = `${(ours / total) * 100}%`
  const cells = osIsLeft
    ? `<i class="os" style="width:${osShare}"></i><i class="ours" style="width:${ourShare}"></i>`
    : `<i class="ours" style="width:${ourShare}"></i><i class="os" style="width:${osShare}"></i>`
  return `<div class="ruler"><span>${osIsLeft ? `OS ${osPx}px` : 'ours'}</span><span class="bar">${cells}</span><span>${
    osIsLeft ? 'ours' : `OS ${osPx}px`
  }</span></div>`
}

function themeToggle() {
  const choices = [...document.querySelectorAll('[data-theme-choice]')]
  for (const choice of choices) {
    choice.addEventListener('click', () => {
      document.body.dataset.theme = choice.dataset.themeChoice
      for (const item of choices) {
        item.setAttribute('aria-pressed', String(item === choice))
      }
    })
  }
}

window.CIOHeader = {
  ICONS,
  frame,
  block,
  renderAll,
  mount,
  rulerMarkup,
  themeToggle,
  PLATFORMS
}

themeToggle()
