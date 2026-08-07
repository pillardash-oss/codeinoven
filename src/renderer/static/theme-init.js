// Apply the OS colour-scheme class before the first paint so a dark-theme user
// never sees the light default surface while the bundle boots on a slow machine.
// The renderer re-resolves the real stored preference (config.theme) once it
// mounts and toggles this class again. Must run as a classic, synchronous
// script in <head> — module scripts execute too late (after first paint).
;(function () {
  try {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      document.documentElement.classList.add('dark')
    }
  } catch {
    // No matchMedia available — keep the light default.
  }
})()
