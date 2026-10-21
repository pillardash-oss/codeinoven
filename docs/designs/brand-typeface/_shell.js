/**
 * The study bar every screen in this folder shares: the mark, the page list, the cut in play
 * and the theme toggle. Kept in one file so a screen only states which page it is.
 *
 * The cut control writes data-cut on the document, which every screen picks up through
 * --font-app, so Alphabet, In the app and the family all answer to one control instead of
 * each screen carrying a copy of the face it shows.
 */
window.CIOShell = (() => {
  const PAGES = [
    ['index.html', 'The family'],
    ['variants.html', 'Two cuts'],
    ['alphabet.html', 'Alphabet'],
    ['surfaces.html', 'In the app'],
  ]

  const CUTS = [
    ['mono', 'Oven Mono'],
    ['box', 'Oven Box'],
  ]

  const MARK = `<svg viewBox="0 0 96 96" aria-hidden="true">
    <path d="M49 17a31 31 0 1 0 0 62" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="square"/>
    <path d="M61 23h23v50H61z" fill="none" stroke="currentColor" stroke-width="7" stroke-linejoin="miter"/>
    <rect x="58" y="45" width="29" height="6" fill="currentColor"/>
    <circle cx="84" cy="48" r="5" fill="#d4af37"/>
  </svg>`

  const THEME_KEY = 'cio-oven-mono-theme'
  const CUT_KEY = 'cio-oven-typeface-cut'

  const NAME = Object.fromEntries(CUTS)

  function stored(key) {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  }

  function remember(key, value) {
    try {
      localStorage.setItem(key, value)
    } catch {
      /* a study with no storage still switches for this visit */
    }
  }

  const cut = () => document.documentElement.dataset.cut === 'box' ? 'box' : 'mono'

  /** Every element that names the cut in its copy follows the control. */
  function nameCut(cutId) {
    for (const node of document.querySelectorAll('[data-cut-name]')) {
      node.textContent = NAME[cutId] || NAME.mono
    }
    for (const node of document.querySelectorAll('[data-cut-weight]')) {
      node.textContent = cutId === 'box' ? '200' : '300'
    }
    for (const node of document.querySelectorAll('[data-cut-primary]')) {
      node.style.fontFamily =
        cutId === 'box'
          ? "'Oven Box', ui-monospace, monospace"
          : "'Oven Mono', ui-monospace, monospace"
    }
  }

  function applyCut(cutId, announce) {
    document.documentElement.dataset.cut = cutId
    nameCut(cutId)
    for (const button of document.querySelectorAll('[data-cut-set]')) {
      button.setAttribute('aria-pressed', String(button.dataset.cutSet === cutId))
    }
    if (announce) window.dispatchEvent(new CustomEvent('cio:cut', { detail: { cut: cutId } }))
  }

  function applyTheme(dark) {
    document.documentElement.classList.toggle('dark', dark)
    const button = document.querySelector('[data-theme-toggle]')
    if (button) {
      button.textContent = dark ? 'Light' : 'Dark'
      button.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme')
    }
  }

  function render(current) {
    const bar = document.getElementById('bar')
    if (!bar) return
    const links = PAGES.map(
      ([href, label]) =>
        `<a href="./${href}"${href === current ? ' aria-current="page"' : ''}>${label}</a>`
    ).join('')
    const cuts = CUTS.map(
      ([id, label]) =>
        `<button type="button" data-cut-set="${id}" aria-pressed="false" title="Set every screen in ${label}">${label}</button>`
    ).join('')
    bar.innerHTML =
      `<span class="brand">${MARK}Oven Mono</span><nav>${links}</nav>` +
      `<span class="cut-set" role="group" aria-label="The cut in play">${cuts}</span>` +
      `<button type="button" data-theme-toggle>Dark</button>`

    for (const button of bar.querySelectorAll('[data-cut-set]')) {
      button.addEventListener('click', () => {
        const next = button.dataset.cutSet
        remember(CUT_KEY, next)
        applyCut(next, true)
      })
    }

    const savedCut = stored(CUT_KEY)
    applyCut(savedCut === 'box' ? 'box' : 'mono', false)

    const button = bar.querySelector('[data-theme-toggle]')
    button.addEventListener('click', () => {
      const dark = !document.documentElement.classList.contains('dark')
      applyTheme(dark)
      remember(THEME_KEY, dark ? 'dark' : 'light')
    })

    const saved = stored(THEME_KEY)
    const prefersDark =
      window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    applyTheme(saved ? saved === 'dark' : prefersDark)
  }

  return { render, cut, applyCut, nameCut, CUTS }
})()
