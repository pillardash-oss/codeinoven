/* The dial and the nodes.
   -------------------------------------------------------------------------
   An assistant with a schedule sits at the hour it runs, so the ring position
   is information rather than decoration: 24 ticks, one an hour, the ticks
   behind the current time filled in gold, and a hand pointing at now. The
   nodes carry `--a` (their angle) and `--r` (their distance) in the markup;
   this file only draws the ticks, so the page still reads without it. */
(() => {
  const dials = document.querySelectorAll('[data-dial]')
  for (const dial of dials) {
    for (let hour = 0; hour < 24; hour += 1) {
      const tick = document.createElement('span')
      tick.className = 'dial-tick'
      tick.style.transform = `rotate(${hour * 15}deg)`
      tick.dataset.major = String(hour % 6 === 0)
      tick.dataset.past = String(hour * 15 <= Number(dial.dataset.now))
      tick.setAttribute('aria-hidden', 'true')
      dial.append(tick)
    }
  }

  // The lectern counts what you are asking for, so a long instruction does not
  // feel like it vanishes into a box.
  const field = document.querySelector('.lectern textarea')
  const count = document.querySelector('[data-word-count]')
  if (field && count) {
    const paint = () => {
      const words = field.value.trim().split(/\s+/).filter(Boolean).length
      count.textContent = words === 0 ? 'Nothing yet' : `${words} word${words === 1 ? '' : 's'}`
    }
    paint()
    field.addEventListener('input', paint)
  }
})()

/* The three modes are real destinations in this study, so pressing one moves
   between the screens instead of pretending. */
for (const button of document.querySelectorAll('[data-mode]')) {
  button.addEventListener('click', () => {
    window.location.href = button.dataset.mode
  })
}

/* An orbit node opens that assistant's bench. */
for (const node of document.querySelectorAll('.node')) {
  node.addEventListener('click', () => {
    window.location.href = './03-bench.html'
  })
}
