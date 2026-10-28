(function () {

/* Layout checks for the study, run only when the page is opened with ?checks=1.
 *
 * The thing that can actually go wrong with a header is an app control sitting
 * under a window-control zone, or a cluster overflowing its frame. Both are
 * geometric questions, so they are measured rather than eyeballed: every frame
 * on the page is opened, each app control is compared against the OS zone's
 * rectangle, and the results are appended as text. A clean run is a page of
 * "ok" lines. */

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

/* Flush means: on the edge the window controls do not own, the bar's content
 * reaches the window edge. Not "somewhere near it": the frame's own padding on
 * that edge has to be zero, and the first or last control has to sit in it.
 *
 * Only the free edge is checked, because the reserved edge is padding by
 * definition and measuring it says nothing. */
function flushness(frame) {
  const style = getComputedStyle(frame)
  const reservedLeft = frame.classList.contains('os-mac') || frame.classList.contains('os-linux-left')
  const freeEdge = reservedLeft ? 'right' : 'left'
  const controls = [...frame.querySelectorAll('.zone button, .zone .chip, .zone .thread')]
    .filter((control) => rectOf(control).width > 0)
  if (controls.length === 0) return null

  const frameRect = rectOf(frame)
  const border = Number.parseFloat(style.borderLeftWidth) || 0
  const slack = Number.parseFloat(
    freeEdge === 'right' ? style.paddingRight : style.paddingLeft
  )
  const last = Math.max(...controls.map((control) => rectOf(control).right))
  const first = Math.min(...controls.map((control) => rectOf(control).left))
  const actual = freeEdge === 'right' ? frameRect.right - border - last : first - frameRect.left - border
  return { edge: freeEdge, padding: Number.isFinite(slack) ? slack : 0, actual: Math.round(actual) }
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
    /* Relative to the frame, not the page: a bar drawn inside the rail demo
       starts 40px further right, and that is the demo's position, not drift. */
    const x = Math.round(rectOf(title).left - rectOf(frame).left)
    const entry = groups.get(key) ?? { values: new Set(), samples: [] }
    entry.values.add(x)
    entry.samples.push(x)
    groups.set(key, entry)
  }
  const findings = []
  for (const [key, entry] of groups) {
    if (entry.values.size <= 1) continue
    const spread = Math.max(...entry.samples) - Math.min(...entry.samples)
    /* Sub-pixel layout rounding lands on a neighbouring pixel now and then; a
       movement the eye can see does not. */
    if (spread < 2) continue
    findings.push(`${key}: title shifts ${spread}px between states (${[...entry.values].join(', ')})`)
  }
  return findings
}

/* The spine is a fixed column, so the one thing it can do wrong is hold more
 * width than its content needs: that dead space lands right before the rule and
 * reads as a gap nobody accounted for. It is measured from the children, not
 * from scrollWidth, which clamps to the column and would hide exactly the gap
 * this check exists to find. */
function spineFill(frames) {
  const rows = []
  for (const frame of frames) {
    const spine = frame.querySelector('.zone.left.spine')
    if (!spine) continue
    const spineRect = rectOf(spine)
    const children = [...spine.children].filter((child) => rectOf(child).width > 0)
    if (children.length === 0) continue
    const contentEnd = Math.max(...children.map((child) => rectOf(child).right))
    const contentStart = Math.min(...children.map((child) => rectOf(child).left))
    const column = Math.round(spineRect.width)
    const content = Math.round(contentEnd - contentStart)
    const brand = [...spine.querySelectorAll('.brand-name')].find((name) => rectOf(name).width > 0)
    const truncated = brand ? brand.scrollWidth > brand.clientWidth + 1 : false
    const platform = (frame.className.match(/os-[a-z-]+/) ?? [''])[0]
    const width = frame.classList.contains('narrow') || frame.closest('.stack.narrow') ? 'narrow' : 'full'
    const parts = children
      .map((child) => `${child.className.split(' ')[0]}=${Math.round(rectOf(child).width)}`)
      .join('+')
    rows.push({
      parts,
      key: `${platform} ${width}`,
      column,
      content,
      slack: column - content,
      truncated
    })
  }
  return rows
}

/* A panel-aligned bar: the column is the thread panel, so the two things worth
 * measuring are whether the rule still lands on the panel's edge and where the
 * wordmark has got to. Column width against content is not a question here. */
function panelAlignment(frames) {
  const rows = []
  let failures = 0
  for (const frame of frames) {
    if (!frame.classList.contains('panel-mode')) continue
    const windowElement = frame.closest('.panel-window')
    if (!windowElement) continue
    const panel = windowElement.querySelector('.panel')
    const content = windowElement.querySelector('.content')
    /* There is no divider to measure any more, so what is measured is where the
       thread's own column begins. */
    const start = frame.querySelector('.zone.center > *')
    /* Two names live in the mark-up and one of them is drawn, so measure the one
       the column actually shows. */
    const names = [...frame.querySelectorAll('.zone.left.spine .brand-name')]
    const brand = names.filter((name) => rectOf(name).width > 0).sort((a, b) => rectOf(a).width - rectOf(b).width)[0] ?? null
    if (!panel || !content || !start) continue

    const problems = []
    const ruleLeft = rectOf(start).left
    const panelRight = rectOf(panel).right
    const contentLeft = rectOf(content).left
    /* The column follows the panel, but it is never narrower than the controls it
       carries: past that point the boundary is the chrome's own end, which is the
       panel's floor rather than a defect. Short of the panel edge is the real
       failure, because there the chrome is sitting over the panel. */
    const offset = Math.round(ruleLeft - panelRight)
    if (offset < -1) problems.push(`the column is ${-offset}px short of the panel edge`)
    /* At the floor the boundary is the chrome's end and the panel's border falls
       where the panel actually is, so the two only have to agree once the panel
       is wide enough to hold the chrome. */
    if (offset <= 1 && Math.abs(contentLeft - ruleLeft) > 1) {
      problems.push(`the panel's border starts ${Math.round(contentLeft - ruleLeft)}px off the rule`)
    }

    const platform = (frame.className.match(/os-[a-z-]+/) ?? [''])[0]
    const width = Math.round(Number(getComputedStyle(windowElement).getPropertyValue('--panel-width').replace('px', '')))
    const labelWidth = brand ? Math.round(rectOf(brand).width) : 0
    const visibility = names.map((name) => getComputedStyle(name).display).join('/')
    const label =
      !brand || labelWidth === 0
        ? 'mark only'
        : brand.scrollWidth > brand.clientWidth + 1
          ? `truncated to ${labelWidth}px`
          : 'whole name'

    /* The width where the wordmark has run out must also be the width the panel
       refuses to go below, or the floor is a claim rather than a rule. */
    const spine = frame.querySelector('.zone.left.spine')
    const clusterEnd = Math.round(ruleLeft - rectOf(frame).left)
    const overflows = spine ? spine.scrollWidth > spine.clientWidth + 1 : false
    const spineWidth = spine ? Math.round(rectOf(spine).width) : 0
    const actions = spine
      ? [...spine.querySelectorAll('.spine-actions .ibtn')].filter(
          (button) => rectOf(button).width > 0
        ).length
      : 0

    if (overflows) problems.push('the spine clip is hiding controls, not a label')

    if (problems.length > 0) failures += 1
    rows.push(
      `${problems.length === 0 ? 'ok' : 'FAIL'} · ${platform} panel ${width}px · thread starts at ${Math.round(
        clusterEnd
      )}px of the bar · spine ${spineWidth}px · label ${labelWidth}px (${label}) · ${actions} actions · names ${visibility}${offset > 1 ? ` · at the chrome floor, ${offset}px past the panel` : ''}${
        problems.length ? ` · ${problems.join('; ')}` : ''
      }`
    )
  }
  return { rows, failures }
}

function run() {
  const report = document.createElement('section')
  report.className = 'section'
  report.id = 'layout-checks'

  /* Demo panels (the two open menus) are not bars: they are drawn to be read,
     not measured, so they are excluded from every geometric check. */
  const frames = [...document.querySelectorAll('.frame')].filter(
    (frame) => !frame.classList.contains('menu-demo')
  )
  const lines = []
  let failures = 0

  /* A panel bar's column is the panel, so the content-sized spine's two rules do
     not apply to it: the wordmark is meant to truncate, and the column is meant
     to hold width its content does not fill. */
  const stable = frames.filter(
    (frame) =>
      !frame.classList.contains('panel-mode') && !frame.classList.contains('panel-hidden')
  )

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

  /* A gap on the free edge is slack nobody asked for. Two pixels of tolerance
     covers a sub-pixel rect, nothing more. */
  const slack = []
  for (const frame of frames) {
    const flush = flushness(frame)
    if (!flush) continue
    const label = `${(frame.className.match(/variant-v\d/) ?? [''])[0]} ${
      frame.closest('.frame-block')?.querySelector('.frame-label b')?.textContent ?? 'frame'
    }`
    if (flush.actual > 2) {
      slack.push(`${label}: ${flush.actual}px of slack on the ${flush.edge} edge`)
    }
  }

  const fill = spineFill(stable)
  const unique = fill.filter((row, index) => fill.findIndex((other) => other.key === row.key) === index)
  const fillLine =
    unique.length === 0
      ? 'no spine on this screen'
      : unique
          .map(
            (row) =>
              `${row.key}: column ${row.column}px · content ${row.content}px [${row.parts}] · dead ${row.slack}px${
                row.truncated ? ' · wordmark truncated' : ''
              }`
          )
          .join('\n')

  /* The column may not hold more than 8px the content does not use, and it may
     never truncate the wordmark: both are the same failure seen from either
     side of a gap. */
  const worstSlack = unique.reduce((max, row) => Math.max(max, row.slack), 0)
  const truncates = unique.some((row) => row.truncated)
  const fillVerdict =
    unique.length === 0
      ? 'none'
      : truncates
        ? 'wordmark truncated'
        : worstSlack > 8
          ? `${worstSlack}px dead space`
          : 'fitted'

  const drift = titleDrift(stable)
  const driftLine =
    drift.length === 0
      ? 'stable · the title starts on the same pixel in every state'
      : drift.join('\n')

  const panel = panelAlignment(frames)
  const panelLine =
    panel.rows.length === 0 ? 'no panel-aligned bar on this screen' : panel.rows.join('\n')

  report.innerHTML = `<div class="section-head"><h2>Panel alignment</h2><span class="meta">${
    panel.failures === 0
      ? panel.rows.length === 0
        ? 'none'
        : 'the rule is the panel edge'
      : `${panel.failures} failing`
  }</span></div><pre class="check-log">${panelLine}</pre><div class="section-head"><h2>Title stability</h2><span class="meta">${
    drift.length === 0 ? 'no drift' : `${drift.length} drifting`
  }</span></div><pre class="check-log">${driftLine}</pre><div class="section-head"><h2>Spine fill</h2><span class="meta">${fillVerdict}</span></div><pre class="check-log">${fillLine}</pre><div class="section-head"><h2>Flush edges</h2><span class="meta">${
    slack.length === 0 ? 'every bar reaches the window edge' : `${slack.length} with slack`
  }</span></div><pre class="check-log">${
    slack.length === 0 ? 'flush · no gap beyond the OS reservation' : slack.join('\n')
  }</pre><div class="section-head"><h2>Fonts</h2><span class="meta">the app's own bundled faces</span></div><pre class="check-log">${fonts.join('\n')}</pre><div class="section-head"><h2>Layout checks</h2><span class="meta">${
    frames.length
  } frames · ${failures} failing</span></div><pre class="check-log">${lines.join('\n')}</pre><div class="section-head"><h2>Zone geometry</h2><span class="meta">percent of bar width</span></div><pre class="check-log">${geometry.join('\n')}</pre>`
  /* The report goes first: a snapshot of a tall page is capped, and the counts
     are the part that has to survive the cap. */
  const page = document.querySelector('.page')
  page.prepend(report)
  report.classList.add('check-report')
}

if (new URLSearchParams(location.search).get('checks') === '1') {
  const start = async () => {
    /* Ask for each face by name: a face nothing has painted yet is not loaded,
       and checking it would report a font that renders fine once the wordmark
       appears. */
    await Promise.all([
      document.fonts.load('0.75rem "Oven Box"'),
      document.fonts.load('1rem "Oven Mono"')
    ]).catch(() => undefined)
    run()
  }
  /* A cached script can arrive after the page has already loaded, in which case
     a listener for `load` would never fire and the screen would silently report
     nothing. */
  const guarded = async () => {
    try {
      await start()
    } catch (error) {
      const report = document.createElement('pre')
      report.style.cssText = 'padding:1rem;border:1px dashed #b00;color:#b00;font:12px monospace'
      report.textContent = `layout checks failed: ${error && error.stack ? error.stack : error}`
      document.querySelector('.page')?.prepend(report)
    }
  }
  if (document.readyState === 'complete') void guarded()
  else window.addEventListener('load', () => void guarded())
}
})()
