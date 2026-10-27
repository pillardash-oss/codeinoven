(function () {

/* Layout checks for the study, run only when the page is opened with ?checks=1.
 *
 * The thing that can actually go wrong with a header is an app control sitting
 * under a window-control zone, or a cluster overflowing its frame. Both are
 * geometric questions, so they are measured rather than eyeballed: every frame
 * on the page is opened, each app control is compared against the OS zone's
 * rectangle, and the results are appended as text. A clean run is a page of
 * "ok" lines. */

const ZONES = { 'os-zone': 'os' }

function rectOf(element) {
  return element.getBoundingClientRect()
}

/* A 2px tolerance: sub-pixel rects report a 1px touch between two controls that
 * are actually flush, which is a measurement artifact rather than a collision. */
function overlaps(a, b) {
  return a.left < b.right - 2 && b.left < a.right - 2 && a.top < b.bottom - 2 && b.top < a.bottom - 2
}

function checkFrame(frame) {
  const problems = []
  const frameRect = rectOf(frame)
  const zones = [...frame.querySelectorAll('.os-zone')].map(rectOf)
  const controls = [...frame.querySelectorAll('button, .chip, .cmd, h1')]

  for (const control of controls) {
    const controlRect = rectOf(control)
    if (controlRect.width === 0) continue
    for (const zone of zones) {
      if (overlaps(controlRect, zone)) {
        const label =
          control.textContent.trim().slice(0, 24) ||
          control.getAttribute('aria-label') ||
          control.className
        problems.push(`under the OS zone: "${label}"`)
      }
    }
    if (controlRect.left < frameRect.left - 0.5 || controlRect.right > frameRect.right + 0.5) {
      problems.push(`outside the frame: "${control.textContent.trim().slice(0, 24)}"`)
    }
  }

  const overflowing = [...frame.querySelectorAll('*')].filter((element) => {
    const style = getComputedStyle(element)
    return (
      element.scrollWidth > element.clientWidth + 1 &&
      style.overflow === 'visible' &&
      element.clientWidth > 0
    )
  })
  for (const element of overflowing) {
    problems.push(`content wider than its box: ${element.className || element.tagName}`)
  }

  /* A centre band that is positioned out of the flex row deliberately shares
     the row's rectangle, so only in-flow zones are compared with each other. */
  const inFlow = [...frame.querySelectorAll('.zone')].filter(
    (zone) => getComputedStyle(zone).position !== 'absolute'
  )
  const zonesOfApp = inFlow.map((z) => ({ z, r: rectOf(z) }))
  for (let i = 0; i < zonesOfApp.length; i += 1) {
    for (let j = i + 1; j < zonesOfApp.length; j += 1) {
      if (overlaps(zonesOfApp[i].r, zonesOfApp[j].r)) {
        problems.push(`zones overlap: ${zonesOfApp[i].z.className} x ${zonesOfApp[j].z.className}`)
      }
    }
  }

  /* The bar should not look empty: at least one app control has to be reachable
     on each side of the centre band, except in the empty state. */
  if (!frame.querySelector('.view-name')) {
    if (!frame.querySelector('.zone.left button')) problems.push('no control in the leading zone')
    if (!frame.querySelector('.zone.right button')) problems.push('no control in the trailing zone')
  }

  /* Two app controls must never sit on top of each other. This is the check the
     anchored centre of V2 has to pass: it is out of the flex row, so flex cannot
     stop it from reaching the leading or trailing cluster. */
  const seen = controls
    .filter((control) => rectOf(control).width > 0)
    .map((control) => ({ control, r: rectOf(control) }))
  for (let i = 0; i < seen.length; i += 1) {
    for (let j = i + 1; j < seen.length; j += 1) {
      if (seen[i].control.contains(seen[j].control)) continue
      if (seen[j].control.contains(seen[i].control)) continue
      if (!overlaps(seen[i].r, seen[j].r)) continue
      /* `.thread` wraps its own title and menu button, so a title and its own
         menu legitimately share a rectangle. */
      if (seen[i].control.closest('.thread') === seen[j].control.closest('.thread') &&
          seen[i].control.closest('.thread') !== null) continue
      const name = (element) =>
        element.textContent.trim().slice(0, 18) || element.className.split(' ')[0]
      const box = (r) => `${Math.round(r.left)}-${Math.round(r.right)}`
      problems.push(
        `controls overlap: "${name(seen[i].control)}" [${seen[i].control.className.split(' ')[0]} ${box(
          seen[i].r
        )}] x "${name(seen[j].control)}" [${seen[j].control.className.split(' ')[0]} ${box(seen[j].r)}]`
      )
    }
  }

  return problems
}

/* Where the three zones actually land, as a share of the bar. This is the
 * measurement the study argues about: whether identity and the thread cluster
 * sit at the same place on a Mac, on Windows and on either Linux direction. */
function geometryOf(frame) {
  const frameRect = rectOf(frame)
  const share = (value) => Math.round(((value - frameRect.left) / frameRect.width) * 1000) / 10
  const brand = frame.querySelector('.zone.left .brand')
  const centre = frame.querySelector('.zone.center')
  const trailing = frame.querySelector('.zone.right')
  if (!brand || !centre || !trailing) return null
  return {
    brand: share(rectOf(brand).left),
    centreFrom: share(rectOf(centre).left),
    centreTo: share(rectOf(centre).right),
    trailTo: share(rectOf(trailing).right)
  }
}

/* The spine's promise is that the title starts at one place regardless of what
 * the thread is called or which of its actions are present. That is a claim
 * about the source, so it is measured on the source: every frame of the same
 * variant, platform and width must put the title at the same x. */
function titleDrift(frames) {
  const groups = new Map()
  for (const frame of frames) {
    const title = frame.querySelector('.thread h1')
    if (!title) continue
    const platform = (frame.className.match(/os-[a-z-]+/) ?? [''])[0]
    /* The variant and the gutter model are part of the identity: a hard-gutter
       frame is deliberately 88px to the right of a natural-gutter one, so the
       two are never the same measurement. */
    const variant = (frame.className.match(/variant-(v\d)/) ?? [''])[0]
    const gutter = frame.classList.contains('hard-gutter') ? 'hard' : 'natural'
    const width =
      frame.classList.contains('narrow') || frame.closest('.stack.narrow') ? 'narrow' : 'full'
    const key = `${variant} ${platform} ${width} ${gutter}`
    const x = Math.round(rectOf(title).left)
    const entry = groups.get(key) ?? { values: new Set(), samples: [] }
    entry.values.add(x)
    entry.samples.push(x)
    groups.set(key, entry)
  }
  const findings = []
  for (const [key, entry] of groups) {
    if (entry.values.size <= 1) continue
    const spread = Math.max(...entry.samples) - Math.min(...entry.samples)
    findings.push(`${key}: title shifts ${spread}px between states (${[...entry.values].join(', ')})`)
  }
  return findings
}

function run() {
  const report = document.createElement('section')
  report.className = 'section'
  report.id = 'layout-checks'

  const frames = [...document.querySelectorAll('.frame')]
  const lines = []
  let failures = 0

  for (const frame of frames) {
    const problems = checkFrame(frame)
    const name = frame.closest('.frame-block')?.querySelector('.frame-label b')?.textContent ?? 'frame'
    const variant = (frame.className.match(/variant-(v\d)/) ?? [])[1] ?? ''
    const width = frame.classList.contains('narrow') || frame.closest('.stack.narrow') ? 'narrow' : 'full'
    const line = `${variant} ${name} ${width}`
    if (problems.length === 0) {
      lines.push(`ok · ${line}`)
    } else {
      failures += 1
      lines.push(`FAIL · ${line}: ${[...new Set(problems)].join('; ')}`)
    }
  }

  const geometry = []
  for (const frame of frames) {
    const geometryRow = geometryOf(frame)
    if (!geometryRow) continue
    const name = frame.closest('.frame-block')?.querySelector('.frame-label b')?.textContent ?? 'frame'
    const variant = (frame.className.match(/variant-(v\d)/) ?? [])[1] ?? ''
    const width = frame.classList.contains('narrow') || frame.closest('.stack.narrow') ? 'narrow' : 'full'
    geometry.push(
      `${variant} ${name} ${width}: brand ${geometryRow.brand}% · centre ${geometryRow.centreFrom}-${geometryRow.centreTo}% · trail ends ${geometryRow.trailTo}%`
    )
  }

  const fonts = ['Oven Box', 'Oven Mono'].map((family) => {
    const loaded = document.fonts.check(`0.75rem "${family}"`)
    return `${family}: ${loaded ? 'loaded' : 'NOT LOADED'}`
  })

  const drift = titleDrift(frames)
  const driftLine =
    drift.length === 0
      ? 'stable · the title starts on the same pixel in every state'
      : drift.join('\n')

  report.innerHTML = `<div class="section-head"><h2>Title stability</h2><span class="meta">${
    drift.length === 0 ? 'no drift' : `${drift.length} drifting`
  }</span></div><pre class="check-log">${driftLine}</pre><div class="section-head"><h2>Fonts</h2><span class="meta">the app's own bundled faces</span></div><pre class="check-log">${fonts.join('\n')}</pre><div class="section-head"><h2>Layout checks</h2><span class="meta">${
    frames.length
  } frames · ${failures} failing</span></div><pre class="check-log">${lines.join('\n')}</pre><div class="section-head"><h2>Zone geometry</h2><span class="meta">percent of bar width</span></div><pre class="check-log">${geometry.join('\n')}</pre>`
  /* The report goes first: a snapshot of a tall page is capped, and the counts
     are the part that has to survive the cap. */
  const page = document.querySelector('.page')
  page.prepend(report)
  report.classList.add('check-report')
}

if (new URLSearchParams(location.search).get('checks') === '1') {
  window.addEventListener('load', async () => {
  /* Ask for each face by name: a face nothing has painted yet is not loaded, and
     checking it would report a font that renders fine once the wordmark appears. */
  await Promise.all([
    document.fonts.load('0.75rem "Oven Box"'),
    document.fonts.load('1rem "Oven Mono"')
  ]).catch(() => undefined)
  run()
})
}
})()
