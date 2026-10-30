/* The dispatch bar folds its own detail, and the two theme buttons are wired in
   theme.js. Nothing else on these screens pretends to work: the study is a
   picture of a flow, so the one interaction it does have is the fold. */
(() => {
  for (const bar of document.querySelectorAll('.dispatch-bar')) {
    const detail = bar.parentElement?.querySelector('.dispatch-detail')
    const arrow = bar.querySelector('.dispatch-arrow')
    if (!detail || !arrow) continue

    const paint = () => {
      const open = bar.getAttribute('aria-expanded') === 'true'
      detail.hidden = !open
      arrow.textContent = open ? '▾' : '▸'
    }

    paint()
    bar.addEventListener('click', () => {
      bar.setAttribute('aria-expanded', String(bar.getAttribute('aria-expanded') !== 'true'))
      paint()
    })
  }
})()
