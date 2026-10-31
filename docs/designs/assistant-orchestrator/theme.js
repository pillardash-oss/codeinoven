/* Theme switch shared by every screen in this study.
   The Light / Dark buttons live in the study header on index.html; every other
   screen follows the reader's last choice through localStorage, and falls back
   to the system preference. The design's own tokens flip on the `.dark` class
   exactly as the app does it. */
(() => {
  const saved = localStorage.getItem('cio-study-theme')
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const theme = saved ?? (prefersDark ? 'dark' : 'light')
  document.documentElement.classList.toggle('dark', theme === 'dark')

  const choices = [...document.querySelectorAll('[data-theme-choice]')]
  for (const choice of choices) {
    const value = choice.getAttribute('data-theme-choice')
    choice.setAttribute('aria-pressed', String(value === theme))
    choice.addEventListener('click', () => {
      document.documentElement.classList.toggle('dark', value === 'dark')
      localStorage.setItem('cio-study-theme', value)
      for (const other of choices) {
        other.setAttribute('aria-pressed', String(other === choice))
      }
    })
  }
})()
