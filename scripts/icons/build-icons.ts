/**
 * Build the CIO icon components from the drawings.
 *
 * Run `bun run icons:build`. It is the only writer of
 * `src/renderer/lib/components/icons/cio/`, so a glyph has one definition: the
 * drawing in `cio-drawings.ts`. Everything the app imports is generated from it.
 *
 *   drawn      fitted to the icon box here, about its own ink centre, with the
 *              stroke compensated for the scale the fit applies
 *   carried    drawn in an earlier round, re-fitted and refined here
 *   solid      ink with no stroke at all, written straight into the box
 *
 * The fit is solved rather than computed: a glyph whose topmost ink is a stroked
 * point gains half a stroke above its geometry and one whose topmost ink is a
 * solid anchor gains nothing, so the scale is estimated, measured through a
 * renderer and corrected until it lands.
 */
import sharp from 'sharp'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CIO_GLYPHS } from './cio-drawings'

const OUT = 'packages/cio-icons/src/lib'
const APP_OUT = 'src/renderer/lib/components/icons/cio'
/** The centre of the 24 box every glyph is drawn in. */
const C = 12
/**
 * Units of ink a picture glyph fills.
 *
 * Lucide's own ink, measured with this same renderer at stroke 1.8, is 19.83 on a
 * full-bleed icon such as the magnifier and 21.84 at its widest, such as the
 * folder. The set draws one uniform box so every mark reads at one size, and 22 is
 * the top of Lucide's own range, which is where a uniform box has to sit to match
 * the widest marks the app draws rather than to be uniformly smaller than them.
 */
const BOX = 22
/** A direction fills this instead, so it does not read as a larger control: the
 *  back chevron measures 13.83 in Lucide, and a direction is never a picture. */
const INDICATOR_BOX = 14
/** The weight a glyph is drawn at in the 24 box. */
const STROKE = 1.8
/** The weight call sites pass, which the emitted components translate. */
const CALL_STROKE = 1.8

const pascal = (id: string) =>
  'Cio' +
  id
    .split('-')
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('')

const render = (
  inner: string,
  px: number,
  stroke: number,
  linecap: 'round' | 'square' = 'square',
  linejoin: 'round' | 'miter' = 'miter'
) =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="${stroke}" stroke-linecap="${linecap}" stroke-linejoin="${linejoin}" color="#ffffff">${inner}</svg>`
    )
  )
    .resize(px, px, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true })

async function inkBox(
  inner: string,
  stroke: number,
  px = 1024,
  linecap: 'round' | 'square' = 'square',
  linejoin: 'round' | 'miter' = 'miter'
) {
  const { data, info } = await render(inner, px, stroke, linecap, linejoin)
  const ch = info.channels
  let x0 = 1e9
  let x1 = -1e9
  let y0 = 1e9
  let y1 = -1e9
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const v = data[(y * info.width + x) * ch]
      const a = ch === 4 ? data[(y * info.width + x) * ch + 3] : 255
      if (v > 127 || a > 127) {
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
      }
    }
  const unit = 24 / px
  return {
    x0: x0 * unit,
    x1: (x1 + 1) * unit,
    y0: y0 * unit,
    y1: (y1 + 1) * unit,
    w: (x1 - x0 + 1) * unit,
    h: (y1 - y0 + 1) * unit
  }
}

/** Fit a drawing to its box about its own centre, correcting until it lands. */
async function fit(id: string, shapes: string, indicator: boolean) {
  const box = indicator ? INDICATOR_BOX : BOX
  const linecap = id === 'rocket' ? 'round' : 'square'
  const linejoin = id === 'rocket' ? 'round' : 'miter'
  const source = await inkBox(shapes, STROKE, 1024, linecap, linejoin)
  const cx = (source.x0 + source.x1) / 2
  const cy = (source.y0 + source.y1) / 2
  let k = (box - STROKE) / (Math.max(source.w, source.h) - STROKE)
  let tx = C
  let ty = C
  let measured = { w: 0, h: 0 }

  for (let pass = 0; pass < 8; pass++) {
    tx = C - k * cx
    ty = C - k * cy
    measured = await inkBox(
      `<g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${k.toFixed(4)})">${shapes}</g>`,
      STROKE,
      1024,
      linecap,
      linejoin
    )
    const extent = Math.max(measured.w, measured.h)
    if (Math.abs(extent - box) < 0.03) break
    k *= box / extent
  }

  if (measured.w > box + 0.15 || measured.h > box + 0.15) {
    throw new Error(
      `${id}: fitted to ${measured.w.toFixed(2)} x ${measured.h.toFixed(2)}, past the ${box}-unit box`
    )
  }
  return { tx, ty, scale: k, width: measured.w, height: measured.h, box }
}

const GLYPH_TS = `/**
 * The shape and weight math every CIO glyph shares.
 *
 * A glyph is drawn in a 24 box and grouped with a fit transform that scales its
 * own drawing up to that box, which is how one set reads at 12, 16 and 20px
 * without redrawing. The transform scales the stroke with the geometry, so a
 * group divides the weight it wants by its own scale to land on it.
 *
 * That weight is the weight the call site asked for, which is the law Lucide
 * follows too: a surface that asks for a 1.8 stroke gets 1.8, and a surface that
 * asks for 2 gets 2. A set drawn a notch heavier than its neighbours is a set that
 * reads as bolder at every size, which is what this file used to do.
 *
 * Generated by scripts/icons/build-icons.ts. Do not edit by hand.
 */
import type { ClassValue, SVGAttributes } from 'svelte/elements'

/**
 * Everything a call site may put on a glyph, matching the shape Lucide's own
 * icons accept so one can replace the other at a call site without the site
 * knowing which set it draws.
 */
export type CioGlyphPassThrough = Record<string, unknown> &
  Omit<SVGAttributes<SVGSVGElement>, 'class'> & {
    class?: ClassValue | undefined | null
    /** The tooltip a call site puts on an icon it uses as a control. */
    title?: string
    /** Tints the glyph, because the drawing strokes in currentColor. */
    color?: string
    /** Accepted and unused: the set is drawn at one weight. */
    absoluteStrokeWidth?: boolean
    /** Accepted and unused, for the same reason. */
    nonScalingStroke?: boolean
    /** Square edge in pixels. */
    size?: number | string
    /** The weight the call site asks for, in a 24 box. */
    strokeWidth?: number | string
  }

export type CioGlyphProps = CioGlyphPassThrough

/**
 * The pre-transform stroke a fitted group carries.
 *
 * The fit transform multiplies the stroke by its own scale, so dividing the
 * requested weight by that scale lands the drawn stroke exactly on it.
 */
export function cioStrokeWidth(requested: number, fitScale: number): number {
  return requested / fitScale
}
`

/** Wrap a note so a component's doc comment is readable rather than one line. */
function wrap(text: string, indent = '  ', width = 76): string {
  const words = text.split(' ')
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines.map((l) => indent + l).join('\n')
}

const TEMPLATE_HEAD = (title: string, note: string) => `<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let {
    size = 16,
    strokeWidth = ${CALL_STROKE},
    class: className = '',
    ...rest
  }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(
    typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || ${CALL_STROKE}
  )
</script>

<!--
  CIO · ${title}
${wrap(note)}
-->
`

/** A stroked glyph: the group carries the fit and the weight math. */
const stroked = (
  title: string,
  note: string,
  transform: string,
  scale: string,
  body: string,
  linecap: 'round' | 'square' = 'square',
  linejoin: 'round' | 'miter' = 'miter'
) =>
  `${TEMPLATE_HEAD(title, note)}<svg
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width={weight}
  stroke-linecap="${linecap}"
  stroke-linejoin="${linejoin}"
  class={className}
  aria-hidden={named ? undefined : 'true'}
  {...rest}
>
  <g transform="${transform}" stroke-width={cioStrokeWidth(weight, ${scale})}>
    ${body}
  </g>
</svg>
`

/** A solid glyph takes no weight: there is no stroke in it to weigh. */
const solidGlyph = (title: string, note: string, body: string) =>
  `<script lang="ts">
  import type { CioGlyphProps } from './glyph'

  let { size = 16, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)
</script>

<!--
  CIO · ${title}
${wrap(note)}
-->
<svg
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="currentColor"
  stroke="none"
  class={className}
  aria-hidden={named ? undefined : 'true'}
  {...rest}
>
  ${body}
</svg>
`

interface Built {
  id: string
  title: string
  file: string
  source: 'drawn' | 'carried' | 'solid'
  scale: number
  ink: string
}

const built: Built[] = []

/**
 * Apply the approved construction pass before fitting and writing each glyph.
 * This is the production counterpart of the reviewed full-set wall.
 */
function refineDrawing(id: string, body: string): string {
  if (id === 'browser' || id === 'rocket') return body

  return body.replace(/<(?:rect|path|circle|ellipse|line|polyline|polygon)\b[^>]*>/g, (tag) => {
    let refined = tag
    const isRect = /^<rect\b/.test(refined)
    const isSolid = /\bfill="currentColor"/.test(refined)

    if (isSolid) {
      refined = refined.replace(/\s+fill="currentColor"/, '')
      refined = /\/>$/.test(refined)
        ? refined.replace(/\s*\/>$/, ' style="fill: var(--icon-anchor, currentColor)" />')
        : refined.replace(/\s*>$/, ' style="fill: var(--icon-anchor, currentColor)">')
    }

    if (isRect) {
      const rx = refined.match(/\brx="([^"]*)"/)
      if (rx && isSolid) refined = refined.replace(/\s+rx="[^"]*"/, '')
      else if (rx && Number(rx[1]) !== 6) refined = refined.replace(/\brx="[^"]*"/, 'rx="0"')
    }
    return refined
  })
}

/** The task-panel fit was corrected on the reviewed wall and stays exact here. */
const FIT_OVERRIDES: Record<string, { tx: number; ty: number; scale: number }> = {
  'tab-tasks': { tx: -1.744, ty: -0.846, scale: 1.17 }
}

await mkdir(OUT, { recursive: true })
await mkdir(APP_OUT, { recursive: true })

for (const entry of CIO_GLYPHS) {
  const file = `${pascal(entry.id)}.svelte`
  if (entry.glyph.kind === 'drawn') {
    const shapes = refineDrawing(entry.id, entry.glyph.shapes)
    const fitted = await fit(entry.id, shapes, !!entry.glyph.indicator)
    const fitOverride = FIT_OVERRIDES[entry.id]
    if (fitOverride) Object.assign(fitted, fitOverride)
    const at16 = (n: number) => ((n / 24) * 16).toFixed(1)
    built.push({
      id: entry.id,
      title: entry.title,
      file,
      source: 'drawn',
      scale: fitted.scale,
      ink: `${fitted.width.toFixed(1)} x ${fitted.height.toFixed(1)} (16px: ${at16(fitted.width)} x ${at16(fitted.height)})`
    })
    await Bun.write(
      join(OUT, file),
      stroked(
        entry.title,
        entry.glyph.note,
        `translate(${fitted.tx.toFixed(3)} ${fitted.ty.toFixed(3)}) scale(${fitted.scale.toFixed(4)})`,
        fitted.scale.toFixed(4),
        shapes,
        entry.id === 'rocket' ? 'round' : 'square',
        entry.id === 'rocket' ? 'round' : 'miter'
      )
    )
  } else if (entry.glyph.kind === 'carried') {
    // A carried drawing arrives fitted to the box of the round that measured it, so
    // it is re-fitted here to the box the set uses now. The drawing itself is kept
    // verbatim: only the transform around it belongs to this run.
    const body = refineDrawing(entry.id, entry.glyph.body)
    const fitted = await fit(entry.id, body, false)
    const fitOverride = FIT_OVERRIDES[entry.id]
    if (fitOverride) Object.assign(fitted, fitOverride)
    built.push({
      id: entry.id,
      title: entry.title,
      file,
      source: 'carried',
      scale: fitted.scale,
      ink: `${fitted.width.toFixed(1)} x ${fitted.height.toFixed(1)}`
    })
    await Bun.write(
      join(OUT, file),
      stroked(
        entry.title,
        entry.glyph.note,
        `translate(${fitted.tx.toFixed(3)} ${fitted.ty.toFixed(3)}) scale(${fitted.scale.toFixed(4)})`,
        fitted.scale.toFixed(4),
        body,
        entry.id === 'rocket' ? 'round' : 'square',
        entry.id === 'rocket' ? 'round' : 'miter'
      )
    )
  } else {
    const body = refineDrawing(entry.id, entry.glyph.body)
    const measured = await inkBox(body, 0)
    built.push({
      id: entry.id,
      title: entry.title,
      file,
      source: 'solid',
      scale: 1,
      ink: `${measured.w.toFixed(1)} x ${measured.h.toFixed(1)}`
    })
    await Bun.write(join(OUT, file), solidGlyph(entry.title, entry.glyph.note, body))
  }
}

// A glyph that was renamed or dropped must not leave its old component behind.
const stale: string[] = []
const expected = new Set(built.map((b) => b.file))
for (const name of await readdir(OUT)) {
  if (name.startsWith('Cio') && name.endsWith('.svelte') && !expected.has(name)) {
    await rm(join(OUT, name))
    stale.push(name)
  }
}

// The app imports the shared package directly. Remove the formerly-generated
// component copies so there is one generated implementation of each drawing.
for (const name of await readdir(APP_OUT)) {
  if (name.startsWith('Cio') && name.endsWith('.svelte')) {
    await rm(join(APP_OUT, name))
  }
}

await Bun.write(join(OUT, 'glyph.ts'), GLYPH_TS)

const registry = built
  .map((b) => ({ ...b, name: pascal(b.id), component: pascal(b.id) }))
  .sort((a, b) => a.name.localeCompare(b.name))

/**
 * The app's own marks, hand-authored beside the drawn set and listed with it, so
 * one folder holds every icon a surface can draw and one registry names them all.
 * These are not generated: they carry their own props and their own marks.
 */
const APP_MARKS: ReadonlyArray<{ id: string; component: string }> = [
  { id: 'assistant', component: 'AssistantIcon' },
  { id: 'assistant-default', component: 'AssistantDefaultIcon' },
  { id: 'assistant-knowledge', component: 'AssistantKnowledgeIcon' },
  { id: 'assistant-task', component: 'AssistantTaskIcon' },
  { id: 'question', component: 'TriangleQuestionMark' }
]

const indexSource = `/**
 * Every CIO glyph, in one place, so a mark has one definition and one name.
 *
 * A surface imports the glyph it draws; a surface that resolves a mark at runtime
 * (a feature registry, a stored setting, a dynamic panel) looks it up here by id,
 * so nothing repeats a drawing and nothing falls back to a second icon language.
 *
 * Generated by scripts/icons/build-icons.ts from scripts/icons/cio-drawings.ts.
 * Do not edit by hand: fix the drawing and run \`bun run icons:build\`.
 */
import type { Component } from 'svelte'
${registry.map((r) => `import ${r.component} from './${r.component}.svelte'`).join('\n')}

/** Every glyph the set draws, by id. */
export const CIO_ICONS = {
${registry.map((r) => `  ${JSON.stringify(r.id)}: ${r.component},`).join('\n')}
} as const satisfies Record<string, Component>

/** The id of a glyph, which is also its key in {@link CIO_ICONS}. */
export type CioIconId = keyof typeof CIO_ICONS

export { type CioGlyphProps, cioStrokeWidth } from './glyph'
export { ${registry.map((r) => r.component).join(', ')} }
`
await Bun.write(join(OUT, 'index.ts'), indexSource)

const appIndexSource = `/**
 * App icon registry: the shared CIO glyph package plus marks specific to the app.
 * Generated by scripts/icons/build-icons.ts. Do not edit by hand.
 */
import type { Component } from 'svelte'
import { CIO_ICONS as SHARED_CIO_ICONS } from '@pillardash-oss/cio-icon'
${APP_MARKS.map((m) => `import ${m.component} from './${m.component}.svelte'`).join('\n')}

export const CIO_ICONS = {
  ...SHARED_CIO_ICONS,
${APP_MARKS.map((m) => `  ${JSON.stringify(m.id)}: ${m.component},`).join('\n')}
} as const satisfies Record<string, Component>

export type CioIconId = keyof typeof CIO_ICONS
export { type CioGlyphProps, cioStrokeWidth } from '@pillardash-oss/cio-icon'
export { ICON_SIZE, RAIL_ICON_STROKE, type IconSize } from './scale'
`
await Bun.write(join(APP_OUT, 'index.ts'), appIndexSource)

// Format what was just written, so the generated files are always the files the
// project's own formatter would have produced and a build cannot leave the tree
// in a state where `prettier --check` fails. The paths are listed rather than
// globbed: no shell expands the pattern here, so a glob would match nothing and
// the build would report a clean tree it never formatted.
const generated = [
  ...built.map((b) => join(OUT, b.file)),
  join(OUT, 'glyph.ts'),
  join(OUT, 'index.ts'),
  join(APP_OUT, 'index.ts')
]
const prettier = Bun.spawnSync([process.execPath, 'x', 'prettier', '--write', ...generated], {
  cwd: process.cwd(),
  stdout: 'ignore',
  stderr: 'inherit'
})
if (prettier.exitCode !== 0) {
  process.stderr.write('prettier could not format the generated glyphs.\n')
  process.exit(1)
}

const lines = [
  `${built.length} glyphs written to ${OUT}`,
  ...(stale.length ? [`removed stale: ${stale.join(', ')}`] : []),
  '',
  'glyph                        source    scale    ink in the 24 box',
  ...built.map(
    (b) => `  ${b.id.padEnd(26)} ${b.source.padEnd(9)} ${b.scale.toFixed(4).padEnd(8)} ${b.ink}`
  )
]
// Every import of a glyph in the app must resolve to a file this run wrote. The
// project-wide check runs through tsgo, which cannot see a component that fails to
// resolve, so an import left pointing at a glyph that was renamed or removed ships
// silently and only fails in the dev server.
const importers: Array<{ path: string; missing: string[] }> = []
const written = new Set([
  ...expected,
  'glyph.ts',
  'index.ts',
  ...APP_MARKS.map((m) => `${m.component}.svelte`)
])
for (const path of new Bun.Glob('src/**/*.{svelte,ts}').scanSync({ cwd: process.cwd() })) {
  const text = await Bun.file(path).text()
  const missing = [
    ...new Set(
      [...text.matchAll(/icons\/cio\/([A-Za-z0-9]+)\.svelte/g)]
        .map((match) => `${match[1]}.svelte`)
        .filter((file) => !written.has(file))
    )
  ]
  if (missing.length > 0) importers.push({ path, missing })
}

const drawn = built.filter((b) => b.source === 'drawn').length
lines.push('', `${drawn} fitted here, ${built.length - drawn} carried or solid`)
process.stdout.write(`${lines.join('\n')}\n`)

if (importers.length > 0) {
  process.stderr.write(
    `\n${importers.length} files import a glyph the set does not draw:\n` +
      importers.map((i) => `  ${i.path}: ${i.missing.join(', ')}`).join('\n') +
      '\nDraw it in scripts/icons/cio-drawings.ts, or point the import at a glyph that exists.\n'
  )
  process.exit(1)
}
process.stdout.write(`every glyph import resolves (${built.length + APP_MARKS.length} marks)\n`)

const packageBuild = Bun.spawnSync([process.execPath, 'run', 'build'], {
  cwd: 'packages/cio-icons',
  stdout: 'inherit',
  stderr: 'inherit'
})
if (packageBuild.exitCode !== 0) {
  process.stderr.write('The CIO icon package could not be built.\n')
  process.exit(1)
}
await rm(join('packages/cio-icons', '.svelte-kit'), { recursive: true, force: true })
