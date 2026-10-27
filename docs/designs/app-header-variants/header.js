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
  download: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M8 2.5v7.5M5 7.5 8 10.5l3-3M3 13h10"/></svg>`,
  info: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 7v4.5M8 4.75h.01"/></svg>`,
  chat: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>`,
  layers: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M8 2.5 14 6l-6 3.5L2 6l6-3.5ZM2 9.5 8 13l6-3.5"/></svg>`,
  globe: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c2 3 2 8 0 11M8 2.5c-2 3-2 8 0 11"/></svg>`,
  minimize: `<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><path d="M2 5h6"/></svg>`,
  maximize: `<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><rect x="2.5" y="2.5" width="5" height="5"/></svg>`,
  close: `<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5"/></svg>`
}

/* A layout that keeps the window controls on the left already names the app in
   its own decoration, so the identity there is the short name; the layouts that
   keep them on the right have no such thing and carry the wordmark. */
const PLATFORMS = {
  mac: { cls: 'os-mac', zone: 'left' },
  win: { cls: 'os-win', zone: 'right' },
  'linux-left': { cls: 'os-linux-left', zone: 'left' },
  'linux-right': { cls: 'os-linux-right', zone: 'right' }
}

/* The app has one long name and one short one, and the layout decides which it
   can afford: the short name is not a platform's name, it is the same name with
   less room. */
const BRAND = { long: 'CodeInOven', short: 'cio' }

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

/* Two names, one of them shown: the wordmark where the platform has room for it
   and the short name everywhere else. Keeping both in the mark-up is what lets
   the column shorten the identity to "cio" when the thread panel squeezes it,
   instead of leaving an ellipsis where a word used to be. */
function brandMarkup() {
  return `<button type="button" class="brand" tabindex="-1">${ICONS.mark}<span class="brand-name brand-name-long">${BRAND.long}</span><span class="brand-name brand-name-short">${BRAND.short}</span></button>`
}

function navigationMarkup() {
  return `${iconButton('back', 'path')}${iconButton('forward', 'dim')}`
}

/* The view's own actions, in the order the app registers them. `count` exists
   so the study can show the spine holding its width while the group changes
   size, which is the one promise the fixed column makes. */
function viewActionsMarkup(count = 3) {
  const icons = ['plus', 'search', 'tools'].slice(3 - Math.max(1, Math.min(3, count)))
  return `<span class="slot">${icons.map((icon) => iconButton(icon)).join('')}</span>`
}

function threadMarkup(options = {}) {
  const status =
    options.working === false
      ? ''
      : `<span class="status"><svg viewBox="0 0 16 16" width="8" height="8" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="8" cy="8" r="5"/></svg>Working</span>`

  if (options.stacked) {
    /* The project icon is the menu, so the title row carries no ellipsis, and the
       state moves under the title as a small badge of its own. */
    return `<div class="thread stacked">${
      options.project === false
        ? ''
        : `<button type="button" class="pico menu-owner" id="proj-icon" tabindex="-1" aria-haspopup="menu">${ICONS.folder}</button>`
    }<div class="thread-text"><h1>${
      options.title ?? 'Repair header collision under caption overlay'
    }</h1><span class="under-status"><i class="dot"></i>Working</span></div></div>`
  }

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

/* The spine of V7 and V8: identity, back and forward, and the view's actions, in
   one column. One separator marks where the column ends; nothing inside it is
   divided, because it reads as one block of chrome.

   In V7 the column fits its content. In V8 it is the thread panel's width, so
   the wordmark gives way as the panel narrows rather than the bar rearranging. */
function spineMarkup(platform, options) {
  /* Three boxes, in order: the identity (natural width, so the column fits the
     name the platform actually shows), the navigation pair, and the view's
     actions in a slot that always reserves room for three. That reservation is
     what keeps the column's width fixed while the actions change, and it is the
     only width in the spine that is fixed, so nothing in it is ever empty. */
  return [
    brandMarkup(platform, options),
    navigationMarkup(),
    `<span class="spine-actions">${variantActions(options)}</span>`
  ].join('')
}

function variantActions(options) {
  /* With no panel docked the bar has no column to spend on buttons, so the view
     actions fold into one ellipsis that opens them. The thread's own name gets
     the room instead. */
  if (options.panelHidden) return iconButton('dots', 'actions-folded')
  return viewActionsMarkup(options.actionCount ?? 3)
}

function seamed(platform, content) {
  const seamSide = PLATFORMS[platform].zone
  return `${content}<span class="seam ${seamSide}"></span>`
}

/* The width below which this bar cannot go: the mark, the navigation pair and
   the actions the view registered, and nothing else. Only the name is elastic, so
   this is also the panel width at which the name has nowhere left to go. */
function spineFloor(options = {}) {
  const actions = Math.max(1, Math.min(3, options.actionCount ?? 3))
  return 88 + actions * 28 + (actions - 1) * 2
}

function frame({ platform, variant, width = 'full', options = {} }) {
  const config = PLATFORMS[platform]
  const classes = ['frame', config.cls, `variant-${variant}`]
  if (width === 'narrow') classes.push('narrow')
  if (options.panelWidth) classes.push('panel-mode')
  if (options.panelHidden) classes.push('panel-hidden')
  classes.push(`controls-${config.zone}`)

  const left =
    variant === 'v7' || variant === 'v8'
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
        ? `<div class="zone center"><span class="spine-rule"></span>${threadMarkup(options)}</div>`
        : variant === 'v8'
          ? `<div class="zone center">${threadMarkup({ ...options, stacked: true })}</div>`
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

  return `<div class="${classes.join(' ')}" style="--spine-floor: ${spineFloor(options)}px">${inner}</div>`
}

/* The rail as the window has it today, 40px wide: the view switcher above, the
   utility group at the foot where downloads, about and the update state live.
   V8 leaves it exactly as it is. */
function railMarkup() {
  /* The rail as the window has it: 40px wide, the view switcher stacked at the
     top, and the utility group pinned to the foot. The mark joins that group,
     last, where the app's own things live. */
  const views = ['chat', 'layers', 'spec', 'globe', 'terminal']
  const items = views
    .map(
      (icon, index) =>
        `<span class="rail-btn${index === 2 ? ' on' : ''}" title="View">${ICONS[icon]}</span>`
    )
    .join('')
  return `<div class="rail"><div class="rail-group">${items}</div><div class="rail-group rail-utility"><span class="rail-btn" title="Downloads">${ICONS.download}</span><span class="rail-btn" title="About">${ICONS.info}</span></div></div>`
}

/* The thread panel, as the app's sidebar draws it: a heading with its count and
   a few rows, the open one marked. It exists so the bar above it can be measured
   against a real column of content. */
function panelRows() {
  const rows = [
    ['Repair header collision under caption overlay', true],
    ['Stabilise the caption overlay inset', false],
    ['Retire the duplicated spacer', false],
    ['Ship the panel-aligned bar', false],
    ['Document the gutter models', false]
  ]
  return `<div class="panel-head"><span>Threads</span><span class="panel-count">${rows.length}</span></div><div class="panel-list">${rows
    .map(
      ([label, open]) =>
        `<div class="panel-row${open ? ' on' : ''}"><i class="panel-dot"></i><span class="panel-name">${label}</span></div>`
    )
    .join('')}</div>`
}

/* V8's whole argument in one picture: the bar's leading cluster is the panel.
   Its last pixel is the panel's edge, and the rule that closes the cluster runs
   straight on down the panel's border, so the header and the body share a single
   line that moves with the panel instead of floating in the window's middle.

   The bar spans the whole window, as the app's header does, so the column it
   hands the panel is the rail plus the panel minus whatever the window controls
   take on that edge. */
function panelWindow({ platform, panelWidth, options = {} }) {
  const config = PLATFORMS[platform]
  const hidden = !panelWidth
  const bar = frame({
    platform,
    variant: 'v8',
    options: hidden ? { ...options, panelHidden: true } : { ...options, panelWidth }
  })
  const width = hidden ? 0 : panelWidth
  /* With the panel hidden there is no column to align to, so the bar keeps its
     chrome at its own width, the identity drops to the mark, and the whole
     cluster hands the room back to the title. */
  return `<div class="window panel-window ${config.cls}${hidden ? ' panel-gone' : ''}" style="--panel-width: ${width}px">${bar}<div class="panel-body">${railMarkup()}${
    hidden ? '' : `<aside class="panel">${panelRows()}</aside>`
  }<div class="content"><span class="fill-label">conversation</span></div></div></div>`
}

function withRail(inner) {
  return `<div class="window-with-rail">${railMarkup()}<div class="window-body">${inner}<div class="window-fill"><span class="fill-label">conversation</span></div></div></div>`
}

function block({ platform, variant, width = 'full', options = {}, label = '' }) {
  const heading = label || `${LABELS[platform]} · ${NOTES[platform]}`
  const panelNote = options.panelWidth
    ? ` · panel ${options.panelWidth}px`
    : options.panelHidden
      ? ' · panel hidden'
      : ''
  const inner =
    (options.panelWidth || options.panelHidden) && variant === 'v8'
      ? panelWindow({ platform, panelWidth: options.panelWidth, options })
      : options.withRail && variant === 'v8'
        ? withRail(frame({ platform, variant, width, options }))
        : frame({ platform, variant, width, options })
  return `<div class="frame-block"><div class="frame-label"><b>${LABELS[platform]}</b><span class="note">${
    notesFor(platform)
  }${width === 'narrow' ? ' · narrow window' : ''}${panelNote}</span></div>${inner}</div>`
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
      const theme = choice.dataset.themeChoice
      document.body.dataset.theme = theme
      /* The tokens live in a `.dark` block, so the class is what actually swaps
         the palette; the data attribute only records the reader's choice. */
      document.documentElement.classList.toggle('dark', theme === 'dark')
      for (const item of choices) {
        item.setAttribute('aria-pressed', String(item === choice))
      }
    })
  }
}

window.CIOHeader = {
  ICONS,
  frame,
  panelWindow,
  block,
  renderAll,
  mount,
  rulerMarkup,
  themeToggle,
  PLATFORMS
}

themeToggle()
