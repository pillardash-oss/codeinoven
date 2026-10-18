/**
 * The study bar every screen in this folder shares: the mark, the page list, and the
 * theme toggle. Kept in one file so a screen only states which page it is.
 */
window.CIOShell = (() => {
  const PAGES = [
    ['index.html', 'The family'],
    ['variants.html', 'Two cuts'],
    ['alphabet.html', 'Alphabet'],
    ['surfaces.html', 'In the app'],
  ]

  const MARK = `<svg viewBox="0 0 96 96" aria-hidden="true">
    <path d="M49 17a31 31 0 1 0 0 62" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="square"/>
    <path d="M61 23h23v50H61z" fill="none" stroke="currentColor" stroke-width="7" stroke-linejoin="miter"/>
    <rect x="58" y="45" width="29" height="6" fill="currentColor"/>
    <circle cx="84" cy="48" r="5" fill="#d4af37"/>
  </svg>`

  const THEME_KEY = 'cio-oven-mono-theme'

  function stored() {
    try {
      return localStorage.getItem(THEME_KEY)
    } catch {
      return null
    }
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
    bar.innerHTML = `<span class="brand">${MARK}Oven Mono</span><nav>${links}</nav><button type="button" data-theme-toggle>Dark</button>`

    const button = bar.querySelector('[data-theme-toggle]')
    button.addEventListener('click', () => {
      const dark = !document.documentElement.classList.contains('dark')
      applyTheme(dark)
      try {
        localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light')
      } catch {
        /* a study with no storage still toggles for this visit */
      }
    })

    const saved = stored()
    const prefersDark =
      window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    applyTheme(saved ? saved === 'dark' : prefersDark)
  }

  return { render }
})()
