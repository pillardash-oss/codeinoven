/**
 * The CIO icons, drawn once, for every product that uses them.
 *
 * The language, read off pass F's own drawings rather than invented:
 *
 *   light      shape outlines stroked at an effective 1.8 units in the 24 box, the
 *              same weight the call site asks for, so a surface asking for 1.8 gets
 *              1.8 the way Lucide's law has it
 *   anchor     one or two solid masses per glyph, filled with no stroke, because
 *              mass is what reads at 16px where an outline needs more extent
 *   radii      2 units on the shape, 1 to 1.3 on the anchors
 *   floor      nothing drawn thinner or closer than 1.5 units, one device pixel
 *              at 16px
 *   box        every glyph fills a 22-unit box, and a direction such as a
 *              chevron fills a 14-unit indicator box instead, which is the size
 *              Lucide's own chevron measures at, because a direction that fills the
 *              picture box reads as a much larger control than the glyphs beside it
 *
 * Nothing here is Lucide geometry. A drawing is written in a local box of roughly
 * 3.4 to 20.6 and fitted to the 22-unit box by `build-icons.ts`, so proportions
 * are the drawing's job and size is the generator's. A glyph carried from pass F
 * or from a settled round arrives already fitted and is kept verbatim, so running
 * the generator again cannot drift it.
 *
 * Run `bun run icons:build` after a change here. It writes the glyph components,
 * the registry and the contact sheet the set is reviewed on.
 */

/** A drawing in a local box, fitted to the icon box by the generator. */
export interface DrawnGlyph {
  kind: 'drawn'
  /** What the glyph means, and what was tried and rejected if anything was. */
  note: string
  shapes: string
  /** A direction rather than a picture: fitted to the 16-unit indicator box. */
  indicator?: boolean
}

/** A glyph that arrived already fitted, kept as the group it shipped as. */
export interface CarriedGlyph {
  kind: 'carried'
  note: string
  /** The fit transform the drawing shipped with. */
  transform: string
  /** The scale inside that transform, which the weight math needs. */
  scale: number
  /** The drawing, already in the fitted box. */
  body: string
}

/** A glyph that is solid ink with no stroke at all, such as the browser mark. */
export interface SolidGlyph {
  kind: 'solid'
  note: string
  body: string
}

export type Glyph = DrawnGlyph | CarriedGlyph | SolidGlyph

/** One glyph. The id is the component's file name and the registry's key. */
export interface GlyphEntry {
  id: string
  /** The glyph's own name, printed in the component's doc comment. */
  title: string
  glyph: Glyph
}

const solid = (x: number, y: number, w: number, h: number, r: number) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="currentColor" stroke="none" />`
const dot = (cx: number, cy: number, r: number) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none" />`

export const CIO_GLYPHS: GlyphEntry[] = [
  {
    id: 'actions',
    title: 'Actions',
    glyph: {
      kind: 'drawn',
      note: 'Actions: a gauge, which is what monitoring looks like. A monitor frame with a cog was Lucide answer and it turns to mush at 16px; the gauge keeps one arc, one needle and one solid hub.',
      shapes: `<path d="M4.4 17.4a7.6 7.6 0 1 1 15.2 0" /><path d="M12 17.4 16.2 11" />${dot(12, 17.4, 2)}`
    }
  },
  {
    id: 'alert-circle',
    title: 'Attention',
    glyph: {
      kind: 'drawn',
      note: 'Attention: a ring carrying the same solid stem and dot as the triangle, so an alert reads the same at every size.',
      shapes: `<circle cx="12" cy="12" r="8.4" />${solid(11, 7.6, 2, 5.6, 1)}${dot(12, 16.4, 1.3)}`
    }
  },
  {
    id: 'archive',
    title: 'Archive',
    glyph: {
      kind: 'drawn',
      note: 'Archive: a lid with a solid tab over a box, which is a stored thing rather than a plain crate.',
      shapes: `<rect x="3.6" y="4.6" width="16.8" height="5" rx="1.6" />${solid(5.8, 6.4, 3.8, 1.4, 0.7)}<path d="M5.4 9.6v8.8a1.6 1.6 0 0 0 1.6 1.6h10a1.6 1.6 0 0 0 1.6-1.6V9.6" /><path d="M10 13.4h4" />`
    }
  },
  {
    id: 'arrow-left',
    title: 'Back to',
    glyph: {
      kind: 'drawn',
      note: 'Back to: a level arrow, on the indicator box with the header chevrons.',
      indicator: true,
      shapes: `<path d="M19.4 12H4.6" /><path d="M10.4 5.8 4.6 12l5.8 6.2" />`
    }
  },
  {
    id: 'arrow-right',
    title: 'On to',
    glyph: {
      kind: 'drawn',
      note: 'On to: the same arrow forward.',
      indicator: true,
      shapes: `<path d="M4.6 12h14.8" /><path d="M13.6 5.8 19.4 12l-5.8 6.2" />`
    }
  },
  {
    id: 'arrow-up',
    title: 'Send',
    glyph: {
      kind: 'drawn',
      note: 'Send: the level arrow up, on the indicator box with the other direction marks, for the control that sends what is written.',
      indicator: true,
      shapes: `<path d="M12 19.6V4.4" /><path d="M5.8 10.6 12 4.4l6.2 6.2" />`
    }
  },
  {
    id: 'arrow-up-right',
    title: 'Open',
    glyph: {
      kind: 'drawn',
      note: 'Open: a diagonal with a corner head, for opening something rather than copying a link.',
      indicator: true,
      shapes: `<path d="M6.6 17.4 17.4 6.6" /><path d="M8.6 6.6h8.8v8.8" />`
    }
  },
  {
    id: 'attention',
    title: 'Decisions made for you',
    glyph: {
      kind: 'drawn',
      note: 'Decisions made for you: a triangle with a solid stem and a solid dot, which is a warning without a second outline inside it.',
      shapes: `<path d="M10.8 4.6a1.4 1.4 0 0 1 2.4 0l7.4 13a1.4 1.4 0 0 1-1.2 2.1H4.6a1.4 1.4 0 0 1-1.2-2.1Z" />${solid(11, 9.4, 2, 5.2, 1)}${dot(12, 16.8, 1.2)}`
    }
  },
  {
    id: 'back',
    title: 'Back',
    glyph: {
      kind: 'drawn',
      note: 'Back: a direction, not a picture. Fitted to the indicator box because a chevron that fills the picture box reads as a much larger control than the glyphs beside it.',
      indicator: true,
      shapes: `<path d="M14.6 5.4 7.4 12l7.2 6.6" />`
    }
  },
  {
    id: 'ban',
    title: 'Blocked',
    glyph: {
      kind: 'drawn',
      note: 'Blocked: a ring struck through at the diagonal, drawn as a stroke so the ring stays open where they cross.',
      shapes: `<circle cx="12" cy="12" r="8.4" /><path d="M6.6 17.4 17.4 6.6" />`
    }
  },
  {
    id: 'board',
    title: 'Board',
    glyph: {
      kind: 'carried',
      note: 'Board: a header rule and three even columns.',
      transform: 'translate(-3.9231 -3.9231) scale(1.3269)',
      scale: 1.3269,
      body: `<path d="M4.4 5.8h15.2" /> <rect x="5.2" y="9.4" width="3.2" height="9.2" rx="1" fill="currentColor" stroke="none" /> <rect x="10.4" y="9.4" width="3.2" height="9.2" rx="1" fill="currentColor" stroke="none" /> <rect x="15.6" y="9.4" width="3.2" height="9.2" rx="1" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'book',
    title: 'Guide',
    glyph: {
      kind: 'drawn',
      note: 'Guide: an open book with a solid spine band, which is a reference rather than a document.',
      shapes: `<path d="M4.6 4.8h4.6a3 3 0 0 1 2.8 1.8 3 3 0 0 1 2.8-1.8h4.6v13.4h-4.6a3 3 0 0 0-2.8 1.8 3 3 0 0 0-2.8-1.8H4.6Z" />${solid(11.1, 8, 1.8, 8.4, 0.9)}`
    }
  },
  {
    id: 'bookmark',
    title: 'Bookmark',
    glyph: {
      kind: 'drawn',
      note: 'Bookmark: a ribbon with a solid tab, which is what tells a bookmark from a plain tag.',
      shapes: `<path d="M6.4 4.8h11.2a1.4 1.4 0 0 1 1.4 1.4v14.2l-7-4.4-7 4.4V6.2a1.4 1.4 0 0 1 1.4-1.4Z" />${solid(8.8, 6.6, 6.4, 2.2, 1.1)}`
    }
  },
  {
    id: 'braces',
    title: 'Method',
    glyph: {
      kind: 'drawn',
      note: 'Method: two braces around a solid point, which is a call rather than a block of code.',
      shapes: `<path d="M9.4 4.6a2.4 2.4 0 0 0-2.4 2.4v3a2.4 2.4 0 0 1-2.4 2.4 2.4 2.4 0 0 1 2.4 2.4v3a2.4 2.4 0 0 0 2.4 2.4" /><path d="M14.6 4.6a2.4 2.4 0 0 1 2.4 2.4v3a2.4 2.4 0 0 0 2.4 2.4 2.4 2.4 0 0 0-2.4 2.4v3a2.4 2.4 0 0 1-2.4 2.4" />${dot(12, 12, 1.6)}`
    }
  },
  {
    id: 'browser',
    title: 'Browser',
    glyph: {
      kind: 'solid',
      note: 'Planet and ring: disc, tilted ring gap, planet inside',
      body: `<path fill="currentColor" fill-rule="evenodd" d="M0.700,12A11.300,11.300 0 1 1 23.300,12A11.300,11.300 0 1 1 0.700,12ZM3.504,8.217A9.300,7.000 24 0 0 20.496,15.783A9.300,7.000 24 0 0 3.504,8.217ZM5.422,9.071A7.200,5.419 24 0 0 18.578,14.929A7.200,5.419 24 0 0 5.422,9.071Z" />`
    }
  },
  {
    id: 'chart',
    title: 'Usage',
    glyph: {
      kind: 'drawn',
      note: 'Usage: three bars rising to a solid peak, which is a measure going up rather than a plain column set.',
      shapes: `<path d="M3.6 19.6h16.8" /><rect x="5.2" y="13.2" width="3.4" height="6.4" rx="1.2" /><rect x="10.3" y="9.6" width="3.4" height="10" rx="1.2" />${solid(15.4, 5.2, 3.4, 14.4, 1.2)}`
    }
  },
  {
    id: 'chat',
    title: 'Chat',
    glyph: {
      kind: 'carried',
      note: 'Chats: a squared bubble with a tapered tail and the line that was said.',
      transform: 'translate(-2.5263 -2.5263) scale(1.2105)',
      scale: 1.2105,
      body: `<path d="M3.5 8.6a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v5.8a2 2 0 0 1-2 2h-7.3L7.4 20v-3.6H5.5a2 2 0 0 1-2-2Z" /> <rect x="7.2" y="10.3" width="9.6" height="2.4" rx="1.2" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'check',
    title: 'Check',
    glyph: {
      kind: 'drawn',
      note: 'Check: one stroke with a long tail, which is what makes it read as acceptance rather than as a corner.',
      shapes: `<path d="M4.6 12.8 9.4 17.6 19.4 6.4" />`
    }
  },
  {
    id: 'check-circle',
    title: 'Done',
    glyph: {
      kind: 'drawn',
      note: 'Done: a ring with a check, the check kept short enough to leave the ring reading as a ring.',
      shapes: `<circle cx="12" cy="12" r="8.4" /><path d="M8.2 12.4 10.8 15 16 9.6" />`
    }
  },
  {
    id: 'chevron-down',
    title: 'Expand',
    glyph: {
      kind: 'drawn',
      note: 'Expand: a chevron pointing down, on the indicator box with the header chevrons.',
      indicator: true,
      shapes: `<path d="M5.4 9.4 12 16 18.6 9.4" />`
    }
  },
  {
    id: 'chevron-up',
    title: 'Collapse',
    glyph: {
      kind: 'drawn',
      note: 'Collapse: the same chevron turned up.',
      indicator: true,
      shapes: `<path d="M5.4 14.6 12 8 18.6 14.6" />`
    }
  },
  {
    id: 'circle',
    title: 'Idle',
    glyph: {
      kind: 'drawn',
      note: 'Idle: one ring, the status mark the app draws for something neither running nor finished.',
      shapes: `<circle cx="12" cy="12" r="7.4" />`
    }
  },
  {
    id: 'clapper',
    title: 'Video',
    glyph: {
      kind: 'drawn',
      note: 'Video: an analogue camera, one reel sitting on the body with a lens cone opening to the right. Two reels over one body read as a face at 32px, which is why there is one, and the cone is what says camera rather than a box with a lid.',
      shapes: `<circle cx="8.8" cy="6.6" r="3.1" />${dot(8.8, 6.6, 1.25)}<path d="M3.4 17.8v-5.3a2.8 2.8 0 0 1 2.8-2.8h9.2a2.8 2.8 0 0 1 2.8 2.8v5.3Z" /><path d="M18.2 12.2 22.2 9.8v7.6l-4-2.4Z" />`
    }
  },
  {
    id: 'clipboard-check',
    title: 'Copied',
    glyph: {
      kind: 'drawn',
      note: 'Copied: the same clipboard with a check where the lines were, so the two read as one object in two states.',
      shapes: `<path d="M8.6 4.8H6.4a1.8 1.8 0 0 0-1.8 1.8v12a1.8 1.8 0 0 0 1.8 1.8h11.2a1.8 1.8 0 0 0 1.8-1.8v-12a1.8 1.8 0 0 0-1.8-1.8h-2.2" />${solid(9.2, 3.4, 5.6, 3, 1.3)}<path d="M9.4 13.4 11.6 15.6 15.4 11.4" />`
    }
  },
  {
    id: 'clipboard-paste',
    title: 'Paste',
    glyph: {
      kind: 'drawn',
      note: 'Paste: a clipboard whose clip is solid, with two lines under it. The clip is the anchor that makes the frame a clipboard.',
      shapes: `<path d="M8.6 4.8H6.4a1.8 1.8 0 0 0-1.8 1.8v12a1.8 1.8 0 0 0 1.8 1.8h11.2a1.8 1.8 0 0 0 1.8-1.8v-12a1.8 1.8 0 0 0-1.8-1.8h-2.2" />${solid(9.2, 3.4, 5.6, 3, 1.3)}<path d="M9.4 12.6h5.2" /><path d="M9.4 15.8h3.2" />`
    }
  },
  {
    id: 'clock',
    title: 'Time',
    glyph: {
      kind: 'drawn',
      note: 'Time: a ring with two solid hands, the hour hand shorter, so the reading survives 12px.',
      shapes: `<circle cx="12" cy="12" r="8.2" />${solid(11, 7, 2, 5.4, 1)}${solid(12.4, 11, 4.2, 2, 1)}`
    }
  },
  {
    id: 'close',
    title: 'Close',
    glyph: {
      kind: 'drawn',
      note: 'Close: two crossed bars with round caps. No anchor, like the chevrons: the crossing is the mass.',
      shapes: `<path d="M6.6 6.6 17.4 17.4" /><path d="M17.4 6.6 6.6 17.4" />`
    }
  },
  {
    id: 'cloud',
    title: 'Cloud deployments',
    glyph: {
      kind: 'drawn',
      note: 'Cloud deployments: a cloud carrying a solid bar, which is the deployment payload. A bare cloud read as weather, and an arrow inside it disappeared at 16px.',
      shapes: `<path d="M6.4 17.6h11.2a4 4 0 0 0 .6-7.9 6.2 6.2 0 0 0-12-1.1 3.6 3.6 0 0 0 .2 9Z" />${solid(9.2, 11.4, 5.6, 2.6, 1.3)}`
    }
  },
  {
    id: 'code',
    title: 'Code',
    glyph: {
      kind: 'drawn',
      note: 'Code: two chevrons with a slash between them, which is what tells code from a plain direction.',
      shapes: `<path d="M8.4 8.4 4.6 12l3.8 3.6" /><path d="M15.6 8.4 19.4 12l-3.8 3.6" /><path d="M13.4 6.4 10.6 17.6" />`
    }
  },
  {
    id: 'commit',
    title: 'Commit',
    glyph: {
      kind: 'drawn',
      note: 'Commit: a stem with a solid node on it. The node is the commit and the stem is what puts it on a line of history.',
      shapes: `<path d="M3.6 12h4.2" /><path d="M16.2 12h4.2" />${dot(12, 12, 3)}`
    }
  },
  {
    id: 'copy',
    title: 'Copy',
    glyph: {
      kind: 'drawn',
      note: 'Copy: a sheet over a sheet, the front one carrying a solid line so the two do not read as one thick frame.',
      shapes: `<path d="M4.6 8.4v9.8a2 2 0 0 0 2 2h9.8" /><rect x="8.6" y="3.8" width="11.6" height="11.6" rx="2" />${solid(11, 7.8, 6.8, 2.2, 1.1)}`
    }
  },
  {
    id: 'cpu',
    title: 'Processor',
    glyph: {
      kind: 'drawn',
      note: 'Processor: a chip with a solid core and eight short pins. The core is the anchor, and the pins stay apart at 12px.',
      shapes: `<rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2" />${solid(10, 10, 4, 4, 1.2)}<path d="M9.6 3.6v2.8M14.4 3.6v2.8M9.6 17.6v2.8M14.4 17.6v2.8M3.6 9.6h2.8M3.6 14.4h2.8M17.6 9.6h2.8M17.6 14.4h2.8" />`
    }
  },
  {
    id: 'cross-circle',
    title: 'Failed',
    glyph: {
      kind: 'drawn',
      note: 'Failed: a ring with a cross drawn as two strokes, so it stays open where they meet.',
      shapes: `<circle cx="12" cy="12" r="8.4" /><path d="M9.2 9.2 14.8 14.8" /><path d="M14.8 9.2 9.2 14.8" />`
    }
  },
  {
    id: 'debugger',
    title: 'Debugger',
    glyph: {
      kind: 'drawn',
      note: 'Debugger: a beetle with two legs a side and one solid band. Lucide bug has nine strokes and turns to a cluster at 16px; this keeps four legs, so the legs read as legs.',
      shapes: `<rect x="6" y="7.4" width="12" height="12" rx="6" /><path d="M6 10.6H3.6" /><path d="M6 16.4H3.6" /><path d="M18 10.6h2.4" /><path d="M18 16.4h2.4" />${solid(8.6, 12.2, 6.8, 2.6, 1.3)}`
    }
  },
  {
    id: 'design',
    title: 'Design',
    glyph: {
      kind: 'drawn',
      note: 'Design: a ruler on the diagonal with three solid ticks, which is measuring and drafting rather than editing text.',
      shapes: `<g transform="rotate(-45 12 12)"><rect x="3.4" y="9.2" width="17.2" height="5.4" rx="1.2" />${solid(6.2, 11, 1.7, 2.2, 0.5)}${solid(9.9, 11, 1.7, 2.2, 0.5)}${solid(13.6, 11, 1.7, 2.2, 0.5)}</g>`
    }
  },
  {
    id: 'diff',
    title: 'Changes',
    glyph: {
      kind: 'drawn',
      note: 'Changes: the page carries both signs now, a solid plus above a solid minus on the same axis, which is what a change set is. It carried only the plus before, which made it the comment mark with different content, and carried no minus at all.',
      shapes: `<path d="M4.6 5.4h8.6l4.6 4.6v9.2a2.2 2.2 0 0 1-2.2 2.2H4.6a2.2 2.2 0 0 1-2.2-2.2V7.6a2.2 2.2 0 0 1 2.2-2.2Z" />${solid(8.5, 9.8, 2.2, 4.6, 1.1)}${solid(7.3, 11, 4.6, 2.2, 1.1)}${solid(7.3, 15.4, 4.6, 2.2, 1.1)}`
    }
  },
  {
    id: 'disk',
    title: 'Storage',
    glyph: {
      kind: 'drawn',
      note: 'Storage: a cylinder with one solid band for the plate it holds, which is the shape storage has had since it was drawn on a schema. The first drawing was a bay with a divider and two lamps, and at 16px it read as a payment card, because a card is exactly a frame with a line across it.',
      shapes: `<path d="M4.6 6.8v10.4c0 1.4 3.3 2.5 7.4 2.5s7.4-1.1 7.4-2.5V6.8" /><path d="M4.6 6.8c0 1.4 3.3 2.5 7.4 2.5s7.4-1.1 7.4-2.5S16.1 4.3 12 4.3 4.6 5.4 4.6 6.8Z" />${solid(4.6, 13.4, 14.8, 2.2, 1.1)}`
    }
  },
  {
    id: 'display',
    title: 'Display',
    glyph: {
      kind: 'drawn',
      note: 'Display: a screen on a stand with one solid line of content, which is what separates it from the terminal frame.',
      shapes: `<rect x="3.4" y="4.8" width="17.2" height="11.4" rx="2" />${solid(6.4, 7.6, 8, 2.2, 1.1)}<path d="M12 16.2v3.4" /><path d="M8.6 19.6h6.8" />`
    }
  },
  {
    id: 'dot',
    title: 'Current',
    glyph: {
      kind: 'drawn',
      note: 'Current: a ring with a solid centre, which is a choice already made rather than one still open.',
      shapes: `<circle cx="12" cy="12" r="7.4" />${dot(12, 12, 2.6)}`
    }
  },
  {
    id: 'download',
    title: 'Download',
    glyph: {
      kind: 'drawn',
      note: 'Download: a solid shaft into a tray. The shaft carries the mass, which lets the tray stay one thin rule.',
      shapes: `${solid(10.9, 3.6, 2.2, 7.6, 1.1)}<path d="M7.4 10.6 12 15.2l4.6-4.6" /><path d="M4.4 18.4v.8a1.4 1.4 0 0 0 1.4 1.4h12.4a1.4 1.4 0 0 0 1.4-1.4v-.8" />`
    }
  },
  {
    id: 'ellipsis',
    title: 'More',
    glyph: {
      kind: 'drawn',
      note: 'More: three solid dots on one level. No outline at all: at 12px an outlined dot is a smudge.',
      shapes: `${dot(6.4, 12, 1.9)}${dot(12, 12, 1.9)}${dot(17.6, 12, 1.9)}`
    }
  },
  {
    id: 'enter',
    title: 'Run',
    glyph: {
      kind: 'drawn',
      note: 'Run: the return arrow, on the indicator box with the other direction marks, for the key that runs what a palette row says.',
      indicator: true,
      shapes: `<path d="M18.4 5.4v8.4a2.8 2.8 0 0 1-2.8 2.8H5.6" /><path d="M9.6 12.8 5.4 16.6l4.2 3.8" />`
    }
  },
  {
    id: 'external-link',
    title: 'Open elsewhere',
    glyph: {
      kind: 'drawn',
      note: 'Open elsewhere: a frame with its top right corner escaped and running out of the box, which is the whole idea in three strokes.',
      shapes: `<path d="M17.4 14.4v4a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h4" /><path d="M13.6 4.6h5.8v5.8" /><path d="M19.4 4.6 11.4 12.6" />`
    }
  },
  {
    id: 'eye',
    title: 'Show',
    glyph: {
      kind: 'drawn',
      note: 'Show: an eye with a solid pupil. The pupil is the anchor and the lid is one closed path, which is what keeps it from reading as two arcs.',
      shapes: `<path d="M2.6 12s3.6-6.6 9.4-6.6S21.4 12 21.4 12s-3.6 6.6-9.4 6.6S2.6 12 2.6 12Z" />${dot(12, 12, 2.6)}`
    }
  },
  {
    id: 'eye-off',
    title: 'Hide',
    glyph: {
      kind: 'drawn',
      note: 'Hide: the eye struck through, the pupil still solid so it reads as the same eye turned off.',
      shapes: `<path d="M2.6 12s3.6-6.6 9.4-6.6S21.4 12 21.4 12s-3.6 6.6-9.4 6.6S2.6 12 2.6 12Z" />${dot(12, 12, 2.6)}<path d="M4.4 19.6 19.6 4.4" />`
    }
  },
  {
    id: 'file-code',
    title: 'Source file',
    glyph: {
      kind: 'drawn',
      note: 'Source file: the page with a folded corner and two chevrons, which is what makes it a file of code rather than of prose.',
      shapes: `<path d="M5.4 5.4a1.6 1.6 0 0 1 1.6-1.6h6.4l5 5v10.2a1.6 1.6 0 0 1-1.6 1.6H7a1.6 1.6 0 0 1-1.6-1.6Z" /><path d="M13.4 3.8v5.2h5" /><path d="M10 12.2 7.8 14.6l2.2 2.4" /><path d="M14.4 12.2l2.2 2.4-2.2 2.4" />`
    }
  },
  {
    id: 'file-text',
    title: 'Document',
    glyph: {
      kind: 'drawn',
      note: 'Document: a page with a folded corner and two solid lines of text, the longer one first.',
      shapes: `<path d="M5.4 5.4a1.6 1.6 0 0 1 1.6-1.6h6.4l5 5v10.2a1.6 1.6 0 0 1-1.6 1.6H7a1.6 1.6 0 0 1-1.6-1.6Z" /><path d="M13.4 3.8v5.2h5" />${solid(8.4, 11.6, 7.2, 2, 1)}${solid(8.4, 15.2, 4.6, 2, 1)}`
    }
  },
  {
    id: 'files',
    title: 'Workspace files',
    glyph: {
      kind: 'drawn',
      note: 'Workspace files: the folder with its tab inked, open at the bottom, with one child panel hanging off a short connector below and to the right of it. Two equal panels were tried first and read as two files rather than as a tree; a first attempt at this one let the child overlap the folder and read as one smudged block.',
      shapes: `<path d="M3.4 11.6V6.6a1.6 1.6 0 0 1 1.6-1.6h2.9l1.9 2.4h5.2a1.6 1.6 0 0 1 1.6 1.6v2.6" />${solid(3.3, 4.8, 6.4, 2.2, 1.4)}<path d="M7.4 11.6v2.4a2 2 0 0 0 2 2h2.2" /><rect x="11.6" y="12.6" width="9" height="7.4" rx="2" />`
    }
  },
  {
    id: 'filter',
    title: 'Filter',
    glyph: {
      kind: 'drawn',
      note: 'Filter: a funnel with a solid mouth, so the narrowing is read from the top down rather than as a plain V.',
      shapes: `<path d="M4.6 6.4 12 14.4l7.4-8" /><path d="M12 14.4v5.4l-3.4 2v-7.4" />${solid(4.4, 4.6, 15.2, 2.4, 1.2)}`
    }
  },
  {
    id: 'find',
    title: 'Find in files',
    glyph: {
      kind: 'drawn',
      note: 'Find in files: the document with a lens over its lower half, which is a search inside a file rather than a search of the app.',
      shapes: `<path d="M5.4 5.4a1.6 1.6 0 0 1 1.6-1.6h6.4l5 5v10.2a1.6 1.6 0 0 1-1.6 1.6H7a1.6 1.6 0 0 1-1.6-1.6Z" /><path d="M13.4 3.8v5.2h5" /><circle cx="10.4" cy="13.6" r="3.2" />${dot(10.4, 13.6, 1.3)}<path d="M12.8 16 15.4 18.6" />`
    }
  },
  {
    id: 'flame',
    title: 'Credits',
    glyph: {
      kind: 'drawn',
      note: 'Credits: a flame with a solid core, which is a budget being burned rather than a warning to read.',
      shapes: `<path d="M12 3.4c2.9 2.7 5.4 5.1 5.4 8.7a5.4 5.4 0 0 1-10.8 0c0-2 1-3.4 2.2-4.8" />${dot(12, 14.4, 2.4)}`
    }
  },
  {
    id: 'folder',
    title: 'Folder',
    glyph: {
      kind: 'drawn',
      note: 'Folder: the container with its tab inked, so the mark has one solid mass and its direction reads from the top left. The first drawing carried a bar floating inside the body with uneven margins above and below it, which is what made it look unmade.',
      shapes: `<path d="M3.6 17.8V7.2a1.8 1.8 0 0 1 1.8-1.8h3.5l2.2 2.8h8.5a1.8 1.8 0 0 1 1.8 1.8v7.8a1.8 1.8 0 0 1-1.8 1.8H5.4a1.8 1.8 0 0 1-1.8-1.8Z" />${solid(3.4, 5.3, 8.4, 2.6, 1.7)}`
    }
  },
  {
    id: 'folder-input',
    title: 'Add to folder',
    glyph: {
      kind: 'drawn',
      note: 'Add to folder: the plain folder with a solid arrow entering it from the right, head first, which is a file being taken in. The first drawing had the arrow leaving the folder over a second tray line, so it read as exporting and carried detail that said nothing.',
      shapes: `<path d="M3.6 17.6V7.4a1.6 1.6 0 0 1 1.6-1.6h3.4l2.2 2.8h8.4a1.6 1.6 0 0 1 1.6 1.6v7.4a1.6 1.6 0 0 1-1.6 1.6H5.2a1.6 1.6 0 0 1-1.6-1.6Z" /><path d="M17.2 10.2 13.6 13.8l3.6 3.6" />${solid(15.2, 12.7, 6.6, 2.2, 1.1)}`
    }
  },
  {
    id: 'folder-open',
    title: 'Open folder',
    glyph: {
      kind: 'drawn',
      note: 'Open folder: the same folder as the closed mark, tab inked and all, with the front panel swung forward and wider than the back. The first drawing carried a band floating across the open front, which is the fault the closed folder was cured of, and its back panel was a stray hook rather than the folder it belongs to.',
      shapes: `<path d="M3.6 13.6V7.2a1.8 1.8 0 0 1 1.8-1.8h3.5l2.2 2.8h8.5a1.8 1.8 0 0 1 1.8 1.8v1.6" />${solid(3.4, 5.3, 8.4, 2.6, 1.7)}<path d="M3.4 18.4 6 11.8h14.4l-2.6 6.6Z" />`
    }
  },
  {
    id: 'folder-plus',
    title: 'New folder',
    glyph: {
      kind: 'drawn',
      note: 'New folder: the plain folder with a solid plus cut into it, which is why it reads as an action and not as a state.',
      shapes: `<path d="M3.6 17.6V7.4a1.6 1.6 0 0 1 1.6-1.6h3.4l2.2 2.8h8.4a1.6 1.6 0 0 1 1.6 1.6v7.4a1.6 1.6 0 0 1-1.6 1.6H5.2a1.6 1.6 0 0 1-1.6-1.6Z" />${solid(10.9, 9.8, 2.2, 7.2, 1.1)}${solid(8.4, 12.3, 7.2, 2.2, 1.1)}`
    }
  },
  {
    id: 'fork',
    title: 'Fork',
    glyph: {
      kind: 'drawn',
      note: 'Fork: one solid node above two, joined by short stems. Three solid nodes read as a fork at 12px where outlines do not.',
      shapes: `${dot(12, 6.4, 2.6)}${dot(6.6, 18.4, 2.6)}${dot(17.4, 18.4, 2.6)}<path d="M12 9v1.4a3.4 3.4 0 0 1-3.4 3.4h-.4" /><path d="M12 10.4a3.4 3.4 0 0 0 3.4 3.4h.4" />`
    }
  },
  {
    id: 'forward',
    title: 'Forward',
    glyph: {
      kind: 'drawn',
      note: 'Forward: the same chevron, mirrored.',
      indicator: true,
      shapes: `<path d="M9.4 5.4 16.6 12l-7.2 6.6" />`
    }
  },
  {
    id: 'grip',
    title: 'Reorder',
    glyph: {
      kind: 'drawn',
      note: 'Reorder: six solid dots in two columns. Nothing else reads as a handle at 12px.',
      shapes: `${dot(9.4, 7, 1.3)}${dot(14.6, 7, 1.3)}${dot(9.4, 12, 1.3)}${dot(14.6, 12, 1.3)}${dot(9.4, 17, 1.3)}${dot(14.6, 17, 1.3)}`
    }
  },
  {
    id: 'hammer',
    title: 'Engineering',
    glyph: {
      kind: 'drawn',
      note: 'Engineering: a hammer, head solid and handle swung out below it, which is the mark the app puts on build and engineering work rather than on a setting.',
      shapes: `<g transform="rotate(-45 8.6 8.6)"><rect x="3.4" y="6.2" width="10.4" height="4.8" rx="1.6" />${solid(6.6, 6.2, 4.4, 4.8, 1.6)}</g><path d="M10.2 10.2 18.8 18.8" />`
    }
  },
  {
    id: 'harness',
    title: 'Harness',
    glyph: {
      kind: 'drawn',
      note: 'Harness: a hexagon around a solid core, which is an engine part rather than a box. Four panels would have been the utilities mark.',
      shapes: `<path d="M12 3.6 19.4 7.8v8.4L12 20.4 4.6 16.2V7.8Z" />${dot(12, 12, 2.8)}`
    }
  },
  {
    id: 'history',
    title: 'History',
    glyph: {
      kind: 'drawn',
      note: 'History: the clock with its dial opened by a rewind corner, which is what tells history from plain time.',
      shapes: `<path d="M3.8 12a8.2 8.2 0 1 0 2.5-5.9" /><path d="M3.6 4.6v4.2h4.2" />${solid(11, 7.8, 2, 4.6, 1)}${solid(12.4, 11.2, 3.8, 2, 1)}`
    }
  },
  {
    id: 'image-off',
    title: 'No preview',
    glyph: {
      kind: 'drawn',
      note: 'No preview: a picture frame struck through, the sun still solid so the frame reads as a picture underneath.',
      shapes: `<rect x="3.6" y="4.8" width="16.8" height="14.4" rx="2" />${dot(9.4, 9.6, 1.8)}<path d="M4.6 19.4 19.4 4.6" />`
    }
  },
  {
    id: 'key',
    title: 'Key',
    glyph: {
      kind: 'drawn',
      note: 'Key: a ring with a solid bore and a shaft with two teeth, so the shaft is not taken for a line of text.',
      shapes: `<circle cx="8" cy="16" r="4.2" />${dot(8, 16, 1.5)}<path d="M11 13 19.4 4.6" /><path d="M16.4 7.6 18.6 9.8" /><path d="M14 10 16.2 12.2" />`
    }
  },
  {
    id: 'keyboard',
    title: 'Keyboard',
    glyph: {
      kind: 'drawn',
      note: 'Keyboard: a frame with four solid keys and a solid space bar, the keys centred in the frame so the margins match on both sides.',
      shapes: `<rect x="2.6" y="6.2" width="18.8" height="11.6" rx="2.2" />${solid(4, 9.2, 2.8, 2.4, 1)}${solid(8.4, 9.2, 2.8, 2.4, 1)}${solid(12.8, 9.2, 2.8, 2.4, 1)}${solid(17.2, 9.2, 2.8, 2.4, 1)}${solid(7.4, 13.8, 9.2, 2.2, 1.1)}`
    }
  },
  {
    id: 'layers',
    title: 'Layers',
    glyph: {
      kind: 'drawn',
      note: 'Layers: one plane above two, the top one carrying a solid edge so the stack reads in depth.',
      shapes: `<path d="M12 4.4 20.4 9 12 13.6 3.6 9Z" />${solid(9.6, 8.2, 4.8, 1.6, 0.8)}<path d="M3.6 12.6 12 17.2l8.4-4.6" />`
    }
  },
  {
    id: 'learn',
    title: 'Learn',
    glyph: {
      kind: 'drawn',
      note: 'Learn: a cap with a solid band across the board and a tassel, which is a taught thing rather than a document.',
      shapes: `<path d="M12 4.6 21 9l-9 4.4L3 9Z" />${solid(9.2, 7.4, 5.6, 1.8, 0.9)}<path d="M6.6 11.4v4.2c0 1.6 2.4 2.8 5.4 2.8s5.4-1.2 5.4-2.8v-4.2" /><path d="M20.2 10v4.6" />`
    }
  },
  {
    id: 'link',
    title: 'Link',
    glyph: {
      kind: 'drawn',
      note: 'Link: two interlocking hooks drawn as strokes, so the crossing reads as a join rather than as a chain.',
      shapes: `<path d="M10.4 13.6a3.6 3.6 0 0 0 5.1 0l3.1-3.1a3.6 3.6 0 0 0-5.1-5.1l-1.6 1.6" /><path d="M13.6 10.4a3.6 3.6 0 0 0-5.1 0l-3.1 3.1a3.6 3.6 0 0 0 5.1 5.1l1.6-1.6" />`
    }
  },
  {
    id: 'lock',
    title: 'Locked',
    glyph: {
      kind: 'drawn',
      note: 'Locked: a body with a solid keyhole under a closed shackle.',
      shapes: `<rect x="4.6" y="10.4" width="14.8" height="9.6" rx="2" />${solid(10.9, 13.4, 2.2, 3.4, 1.1)}<path d="M8.4 10.4V7.6a3.6 3.6 0 0 1 7.2 0v2.8" />`
    }
  },
  {
    id: 'lock-open',
    title: 'Unlocked',
    glyph: {
      kind: 'drawn',
      note: 'Unlocked: the same body and keyhole with the shackle swung open, so the two read as one lock in two states.',
      shapes: `<rect x="4.6" y="10.4" width="14.8" height="9.6" rx="2" />${solid(10.9, 13.4, 2.2, 3.4, 1.1)}<path d="M8.4 10.4V7.6a3.6 3.6 0 0 1 7.2 0" />`
    }
  },
  {
    id: 'maximize',
    title: 'Maximise',
    glyph: {
      kind: 'drawn',
      note: 'Maximise: four corners opening outward, drawn as corners rather than arrows so it never reads as a drag handle.',
      shapes: `<path d="M9.4 4.6H6a1.4 1.4 0 0 0-1.4 1.4v3.4" /><path d="M14.6 4.6H18a1.4 1.4 0 0 1 1.4 1.4v3.4" /><path d="M19.4 14.6v3.4a1.4 1.4 0 0 1-1.4 1.4h-3.4" /><path d="M4.6 14.6v3.4a1.4 1.4 0 0 0 1.4 1.4h3.4" />`
    }
  },
  {
    id: 'memory',
    title: 'Memory',
    glyph: {
      kind: 'drawn',
      note: 'Memory: a head, closed at the chin, holding two solid nodes joined by a short line, which is a mind with what it kept wired together. The plates before it read as a list or a store and said nothing about whose memory it is; a brain outline read as a cloud at 16px, and a first head with a neck line read as a lightbulb.',
      shapes: `<path d="M12 3.8a7 7 0 0 1 7 7c0 2.2-1 3.6-2 4.8-.8 1-1.2 1.8-1.3 3-.1 1.1-1 1.9-2.1 1.9h-3.2c-1.1 0-2-.8-2.1-1.9-.1-1.2-.5-2-1.3-3-1-1.2-2-2.6-2-4.8a7 7 0 0 1 7-7Z" />${dot(9.4, 10.6, 1.6)}${dot(14.6, 10.6, 1.6)}<path d="M11 10.6h2" />`
    }
  },
  {
    id: 'merge',
    title: 'Merge',
    glyph: {
      kind: 'drawn',
      note: 'Merge: a line joining another at a solid node, the counterpart of the pull request arrow.',
      shapes: `<circle cx="6.6" cy="6.4" r="2.6" />${solid(5.6, 9, 2, 8.6, 1)}<path d="M17.4 6.4v3.2a4.2 4.2 0 0 1-4.2 4.2H10.6" /><path d="M12.8 11.2 10.2 13.8l2.6 2.6" />${dot(17.4, 18, 2.4)}`
    }
  },
  {
    id: 'message',
    title: 'Comment',
    glyph: {
      kind: 'drawn',
      note: 'Comment: a bubble with a tail at the lower right and one solid line in it, which is something said about what it points at. It was a rounded rectangle carrying two bars, which is the silhouette the diff mark wore, so the two were the same shape with different content; the chats mark keeps the squared bubble and the tail on the other side.',
      shapes: `<path d="M3.6 7.4a2.4 2.4 0 0 1 2.4-2.4h12a2.4 2.4 0 0 1 2.4 2.4v7.2a2.4 2.4 0 0 1-2.4 2.4h-1.2v3.6l-4.6-3.6H6a2.4 2.4 0 0 1-2.4-2.4Z" />${solid(7.2, 9.9, 9.6, 2.4, 1.2)}`
    }
  },
  {
    id: 'message-plus',
    title: 'New comment',
    glyph: {
      kind: 'drawn',
      note: 'New comment: the same bubble with a solid plus where the line was, so a reader who knows one knows the other.',
      shapes: `<path d="M3.6 7.4a2.4 2.4 0 0 1 2.4-2.4h12a2.4 2.4 0 0 1 2.4 2.4v7.2a2.4 2.4 0 0 1-2.4 2.4h-1.2v3.6l-4.6-3.6H6a2.4 2.4 0 0 1-2.4-2.4Z" />${solid(10.9, 6.6, 2.2, 7, 1.1)}${solid(8.5, 9, 7, 2.2, 1.1)}`
    }
  },
  {
    id: 'mic',
    title: 'Record',
    glyph: {
      kind: 'drawn',
      note: 'Record: a capsule with a solid core in a cradle. The core is the anchor and the cradle is what makes it a microphone.',
      shapes: `<rect x="9.4" y="3.4" width="5.2" height="10" rx="2.6" />${solid(10.8, 5.8, 2.4, 5, 1.2)}<path d="M6.4 11.6a5.6 5.6 0 0 0 11.2 0" /><path d="M12 17.2v3.4" />`
    }
  },
  {
    id: 'milestone',
    title: 'Milestone',
    glyph: {
      kind: 'drawn',
      note: 'Milestone: a stem with a flag on it, the flag solid so it reads on a timeline.',
      shapes: `<path d="M6.4 3.6v16.8" /><path d="M6.4 6h12l2.4 2.2-2.4 2.2h-12Z" />${solid(9, 7.2, 7.6, 2, 1)}`
    }
  },
  {
    id: 'minimize',
    title: 'Collapse',
    glyph: {
      kind: 'drawn',
      note: 'Collapse: four corners closing inward, the inverse of the maximise mark, so a pair of controls reads as one gesture either way.',
      shapes: `<path d="M9.4 4.6v3.6a1.4 1.4 0 0 1-1.4 1.4H4.4" /><path d="M14.6 4.6v3.6a1.4 1.4 0 0 0 1.4 1.4h3.6" /><path d="M19.6 14.6h-3.6a1.4 1.4 0 0 0-1.4 1.4v3.6" /><path d="M4.4 14.6h3.6a1.4 1.4 0 0 1 1.4 1.4v3.6" />`
    }
  },
  {
    id: 'minus',
    title: 'Remove',
    glyph: {
      kind: 'drawn',
      note: 'Remove: one solid bar. It is the add mark with its vertical taken away, so the two cannot be confused.',
      shapes: `${solid(4.6, 10.9, 14.8, 2.2, 1.1)}`
    }
  },
  {
    id: 'network',
    title: 'Network',
    glyph: {
      kind: 'drawn',
      note: 'Network: one node above two joined ones, the two lower ones solid, which is a coordinator with its workers.',
      shapes: `<rect x="9.4" y="3.4" width="5.2" height="4.2" rx="1.4" /><rect x="3.4" y="16.4" width="5.2" height="4.2" rx="1.4" /><rect x="15.4" y="16.4" width="5.2" height="4.2" rx="1.4" /><path d="M12 7.6v4" /><path d="M12 11.6 6 16.4" /><path d="M12 11.6 18 16.4" />${dot(6, 18.5, 1.4)}${dot(18, 18.5, 1.4)}`
    }
  },
  {
    id: 'note',
    title: 'Thread note',
    glyph: {
      kind: 'drawn',
      note: 'Thread note: a quill. The vane runs both sides of the shaft and tapers to a point at each end, the shaft carries on past the vane to the nib, and one solid band crosses the middle. The mark it replaces hung a card off a bar on the left, which made it narrower than every mark beside it, and the pass after that was a single-sided blade, which read as the bowl of a spoon.',
      shapes: `<path d="M21.6 2.4Q7.06 5.06 4.4 19.6Q18.94 16.94 21.6 2.4Z" /><path d="M21.6 2.4 1.4 22.6" /><g transform="rotate(-45 12 12)">${solid(8.6, 11.1, 6.8, 1.7, 0.85)}</g>`
    }
  },
  {
    id: 'notes',
    title: 'Notes',
    glyph: {
      kind: 'drawn',
      note: 'Notes: a sticky note, which is what the feature is. The sheet is square, its lower right corner peels forward, and one line is solid. A plain rectangle with lines on it is a document, not a note you stick somewhere.',
      shapes: `<path d="M5.4 4.6h13.2a1.8 1.8 0 0 1 1.8 1.8v8.4l-4.4 4.6H5.4a1.8 1.8 0 0 1-1.8-1.8V6.4a1.8 1.8 0 0 1 1.8-1.8Z" /><path d="M20.4 14.8h-2.8a1.6 1.6 0 0 0-1.6 1.6v3" />${solid(7.2, 9.2, 8.8, 2.6, 1.3)}`
    }
  },
  {
    id: 'notifications',
    title: 'Notifications',
    glyph: {
      kind: 'drawn',
      note: 'Notifications: a bell with a solid mouth bar and a clapper. The bar is the anchor; a thin rim there disappeared into the body at 16px.',
      shapes: `<path d="M7 16.4V11a5 5 0 0 1 10 0v5.4" />${solid(4.4, 16.4, 15.2, 2.6, 1.3)}<path d="M10.2 21a2.2 2.2 0 0 0 3.6 0" />`
    }
  },
  {
    id: 'package',
    title: 'Package',
    glyph: {
      kind: 'drawn',
      note: 'Package: a box in three quarter view with a solid seal, which is a shipped thing rather than a container on a shelf.',
      shapes: `<path d="M4.4 8.6 12 4.6l7.6 4v6.8L12 19.4l-7.6-4Z" /><path d="M4.4 8.6 12 12.6l7.6-4" /><path d="M12 12.6v6.8" />${solid(9.6, 6.2, 4.8, 1.8, 0.9)}`
    }
  },
  {
    id: 'palette',
    title: 'Appearance',
    glyph: {
      kind: 'drawn',
      note: 'Appearance: a palette with three solid wells, which is what makes it a colour set rather than a mask.',
      shapes: `<path d="M12 3.8a8.2 8.2 0 0 0 0 16.4c1.3 0 2.1-.9 2.1-2 0-.6-.3-1-.6-1.4-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h1.6a3.6 3.6 0 0 0 3.6-3.6C20.2 6.8 16.6 3.8 12 3.8Z" />${dot(8.4, 9.2, 1.6)}${dot(12, 7.4, 1.6)}${dot(15.6, 9.6, 1.6)}`
    }
  },
  {
    id: 'panel-bottom',
    title: 'Dock bottom',
    glyph: {
      kind: 'drawn',
      note: 'Dock bottom: the same frame with its lower band solid.',
      shapes: `<rect x="3.4" y="4.8" width="17.2" height="14.4" rx="2" />${solid(3.4, 13, 17.2, 6.2, 2)}<path d="M3.4 13h17.2" />`
    }
  },
  {
    id: 'panel-right',
    title: 'Dock right',
    glyph: {
      kind: 'drawn',
      note: 'Dock right: a frame with its right column solid, which is the dock drawn as a state rather than as an action.',
      shapes: `<rect x="3.4" y="4.8" width="17.2" height="14.4" rx="2" />${solid(14.6, 4.8, 6, 14.4, 2)}<path d="M14.6 4.8v14.4" />`
    }
  },
  {
    id: 'paperclip',
    title: 'Attach',
    glyph: {
      kind: 'drawn',
      note: 'Attach: one continuous wire folded four times, which is the whole shape of a paperclip.',
      shapes: `<path d="M17.4 11.4 10.8 18a4.2 4.2 0 0 1-6-6l7.4-7.4a3 3 0 0 1 4.2 4.2l-7.2 7.2a1.6 1.6 0 0 1-2.2-2.2l6.4-6.4" />`
    }
  },
  {
    id: 'pause',
    title: 'Pause',
    glyph: {
      kind: 'drawn',
      note: 'Pause: two solid bars carrying the same mass as the play triangle, so the two read as one control.',
      shapes: `${solid(8.4, 5.4, 2.6, 13.2, 1.2)}${solid(13, 5.4, 2.6, 13.2, 1.2)}`
    }
  },
  {
    id: 'pencil',
    title: 'Rename',
    glyph: {
      kind: 'drawn',
      note: 'Rename: a pencil with a ferrule line, drawn as an outline so the eye lands on the tip.',
      shapes: `<path d="M4.4 19.6l1.1-4.6L16 4.6a2.3 2.3 0 0 1 3.4 3.4L9 18.5Z" /><path d="M14.6 6.2 18 9.6" />`
    }
  },
  {
    id: 'person',
    title: 'Person',
    glyph: {
      kind: 'drawn',
      note: 'Person: a solid head over a shoulder line. The head is solid because a stroked circle this small reads as a letter O.',
      shapes: `${dot(12, 8.2, 4)}<path d="M4.6 20.4a7.4 7.4 0 0 1 14.8 0" />`
    }
  },
  {
    id: 'person-plus',
    title: 'Invite',
    glyph: {
      kind: 'drawn',
      note: 'Invite: the person mark with a solid plus beside it, for an account being brought in.',
      shapes: `${dot(10.4, 8.2, 3.8)}<path d="M3.4 20.4a7 7 0 0 1 13.4-2.6" />${solid(18.4, 12.2, 2, 7, 1)}${solid(15.9, 14.7, 7, 2, 1)}`
    }
  },
  {
    id: 'pin',
    title: 'Pin',
    glyph: {
      kind: 'drawn',
      note: 'Pin: a solid crown over a body and a stem, which is a pin held in place rather than a map marker.',
      shapes: `${solid(9.4, 3.6, 5.2, 2.6, 1.3)}<path d="M9.4 6.2h5.2l-.6 5 2.6 2.6v2.4H7.4v-2.4l2.6-2.6Z" /><path d="M12 16.2v4.2" />`
    }
  },
  {
    id: 'play',
    title: 'Play',
    glyph: {
      kind: 'drawn',
      note: 'Play: a solid triangle. Filled rather than stroked, because a stroked triangle this small reads as a warning.',
      shapes: `<path d="M8.6 5.4 19 12 8.6 18.6Z" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'plug',
    title: 'Connected',
    glyph: {
      kind: 'drawn',
      note: 'Connected: a plug with two solid prongs, which is what tells a connected capability from a running server.',
      shapes: `${solid(9.4, 3.6, 2, 4.8, 1)}${solid(12.6, 3.6, 2, 4.8, 1)}<rect x="6.4" y="8.6" width="11.2" height="6.4" rx="2" /><path d="M12 15v5.4" />`
    }
  },
  {
    id: 'plus',
    title: 'Add',
    glyph: {
      kind: 'drawn',
      note: 'Add: a solid vertical bar crossed by one stroke, so it cannot be mistaken for the close cross at 12px.',
      shapes: `${solid(10.9, 4.6, 2.2, 14.8, 1.1)}<path d="M4.6 12h14.8" />`
    }
  },
  {
    id: 'projects',
    title: 'Project',
    glyph: {
      kind: 'carried',
      note: 'Project: a folder, which is what a project is.',
      transform: 'translate(-2.5263 -2.5263) scale(1.2105)',
      scale: 1.2105,
      body: `<path d="M3.5 16.7V7.6a2 2 0 0 1 2-2h3.7l2.2 2.8h7.1a2 2 0 0 1 2 2v6.3a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2Z" /> <rect x="6.6" y="10.6" width="7" height="4.4" rx="1" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'pull-request',
    title: 'Pull request',
    glyph: {
      kind: 'drawn',
      note: 'Pull request: a branch feeding an arrow into a line with a second node, which is a change waiting to be merged.',
      shapes: `<circle cx="6.6" cy="6.4" r="2.6" />${solid(5.6, 9, 2, 8.6, 1)}<path d="M17.4 15.4V12a3.4 3.4 0 0 0-3.4-3.4H10.6" /><path d="M13.4 6.2 10.4 8.6l3 2.4" />${dot(17.4, 18, 2.4)}`
    }
  },
  {
    id: 'redo',
    title: 'Redo',
    glyph: {
      kind: 'drawn',
      note: 'Redo: the undo mark mirrored, on the right, so the pair reads as one history either way.',
      shapes: `<path d="M19.6 12a7.6 7.6 0 1 1-2.3-5.4" /><path d="M19.6 4.4v4.4h-4.4" />`
    }
  },
  {
    id: 'refresh',
    title: 'Refresh',
    glyph: {
      kind: 'drawn',
      note: 'Refresh: one ring made of two arcs, each carrying its own corner, so the mark reads as a cycle. A single arc with one corner is the redo mark, and the two were the same drawing until this one took the second head.',
      shapes: `<path d="M19.4 9.6a7.5 7.5 0 0 0-12.8-4.2" /><path d="M4.6 14.4a7.5 7.5 0 0 0 12.8 4.2" /><path d="M19.4 4.8v4.8h-4.8" /><path d="M4.6 19.2v-4.8h4.8" />`
    }
  },
  {
    id: 'rocket',
    title: 'Release',
    glyph: {
      kind: 'drawn',
      note: 'Release: a body with solid fins and a solid eye, which is a launch rather than a plain arrow.',
      shapes: `<path d="M12 3.6c3.2 2.4 5 5.8 5 9.6l-2.4 2.8H9.4L7 13.2c0-3.8 1.8-7.2 5-9.6Z" />${dot(12, 9.6, 1.9)}<path d="M9.4 16 7.6 20M14.6 16l1.8 4" />`
    }
  },
  {
    id: 'save',
    title: 'Save',
    glyph: {
      kind: 'drawn',
      note: 'Save: a disk with a solid shutter. The shutter is the anchor, and it is what stops the frame reading as a plain box.',
      shapes: `<path d="M4.6 6a1.4 1.4 0 0 1 1.4-1.4h10.2l3.2 3.2V18a1.4 1.4 0 0 1-1.4 1.4H6a1.4 1.4 0 0 1-1.4-1.4Z" /><path d="M8.2 4.6v5h6.6v-5" />${solid(7.6, 13, 8.8, 6.4, 1.2)}`
    }
  },
  {
    id: 'scoped',
    title: 'Scoped',
    glyph: {
      kind: 'carried',
      note: 'Scoped: a field with the selected region solid at its centre.',
      transform: 'translate(-2.5263 -2.5263) scale(1.2105)',
      scale: 1.2105,
      body: `<rect x="3.5" y="3.5" width="17" height="17" rx="2" /> <rect x="9" y="9" width="6" height="6" rx="1.2" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'search',
    title: 'Search',
    glyph: {
      kind: 'drawn',
      note: 'Search: a lens with a solid pupil and a handle thick enough to carry the mass at 16px. An empty lens read as a plain ring.',
      shapes: `<circle cx="10.4" cy="10.4" r="6.2" /><path d="M15.2 15.2 20.4 20.4" />${dot(10.4, 10.4, 2.4)}`
    }
  },
  {
    id: 'send',
    title: 'Send',
    glyph: {
      kind: 'drawn',
      note: 'Send: a folded arrow with the fold line drawn, so it reads as a paper plane rather than as a plain triangle.',
      shapes: `<path d="M20.4 3.6 3.8 10.4l6.2 2.6 2.6 6.2Z" /><path d="M20.4 3.6 10 13" />`
    }
  },
  {
    id: 'server',
    title: 'Server',
    glyph: {
      kind: 'drawn',
      note: 'Server: two plates with solid indicators, which is a rack read at 12px. A single plate is a plain box.',
      shapes: `<rect x="3.6" y="4.8" width="16.8" height="6" rx="2" /><rect x="3.6" y="13.2" width="16.8" height="6" rx="2" />${dot(7.4, 7.8, 1.4)}${dot(7.4, 16.2, 1.4)}`
    }
  },
  {
    id: 'shield-alert',
    title: 'At risk',
    glyph: {
      kind: 'drawn',
      note: 'At risk: the same shield carrying the solid stem and dot the attention triangle uses.',
      shapes: `<path d="M12 3.6 19.6 6.4v5.2c0 4.4-3 7.6-7.6 8.8-4.6-1.2-7.6-4.4-7.6-8.8V6.4Z" />${solid(11, 8, 2, 4.6, 1)}${dot(12, 15.4, 1.3)}`
    }
  },
  {
    id: 'shield-check',
    title: 'Verified',
    glyph: {
      kind: 'drawn',
      note: 'Verified: a shield with a check in it. The shield is the shape and the check is the meaning, so neither takes an anchor.',
      shapes: `<path d="M12 3.6 19.6 6.4v5.2c0 4.4-3 7.6-7.6 8.8-4.6-1.2-7.6-4.4-7.6-8.8V6.4Z" /><path d="M8.8 12 11.2 14.4 15.6 9.6" />`
    }
  },
  {
    id: 'skip-forward',
    title: 'Skip',
    glyph: {
      kind: 'drawn',
      note: 'Skip: a solid triangle against a solid bar. The bar is the anchor and it is what says the motion stops here.',
      shapes: `<path d="M6.4 6.4 14 12l-7.6 5.6Z" fill="currentColor" stroke="none" />${solid(15.6, 6.4, 2.4, 11.2, 1.2)}`
    }
  },
  {
    id: 'sparkles',
    title: 'Generated',
    glyph: {
      kind: 'drawn',
      note: 'Generated: one solid sparkle with a smaller outlined one beside it. The solid one carries the meaning and the outline says there is more of it.',
      shapes: `<path d="M10.6 3.6l1.7 4.6 4.6 1.7-4.6 1.7-1.7 4.6-1.7-4.6L4.3 9.9l4.6-1.7Z" fill="currentColor" stroke="none" /><path d="M17.6 13.8l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9Z" />`
    }
  },
  {
    id: 'spinner',
    title: 'Working',
    glyph: {
      kind: 'drawn',
      note: 'Working: three quarters of a ring with a solid head, so a rotation reads as a sweep rather than as a static ring. It replaces the Lucide spinner everywhere the app says something is in flight, and the caller keeps its own spin animation.',
      shapes: `<path d="M4.6 12a7.4 7.4 0 1 1 7.4 7.4" />${dot(12, 19.4, 2.2)}`
    }
  },
  {
    id: 'star',
    title: 'Favourite',
    glyph: {
      kind: 'drawn',
      note: 'Favourite: a five point star, outline only. Its silhouette is the meaning, so an anchor inside it only muddies it.',
      shapes: `<path d="M12 3.6l2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.8-5.4 2.8 1-6.1L3.2 10l6.1-.9Z" />`
    }
  },
  {
    id: 'stop',
    title: 'Stop',
    glyph: {
      kind: 'drawn',
      note: 'Stop: one solid rounded square. Nothing else reads as a stop at 13px, and it sits opposite the play triangle in the same control.',
      shapes: `${solid(6.4, 6.4, 11.2, 11.2, 2.8)}`
    }
  },
  {
    id: 'subagent',
    title: 'Subagent',
    glyph: {
      kind: 'drawn',
      note: 'Subagent: a head with an aerial and two solid eyes. The eyes carry the mass; one wider solid visor was tried and read as a robot mask rather than a worker.',
      shapes: `<rect x="4.2" y="8.6" width="15.6" height="11.2" rx="3" /><path d="M12 8.6V5.4" />${dot(12, 3.8, 1.7)}${solid(7.6, 12.6, 3.2, 3.2, 1.2)}${solid(13.2, 12.6, 3.2, 3.2, 1.2)}`
    }
  },
  {
    id: 'swap',
    title: 'Swap',
    glyph: {
      kind: 'drawn',
      note: 'Swap: two arrows crossing, on the indicator box so it matches the other direction marks.',
      indicator: true,
      shapes: `<path d="M4.6 9.2h13" /><path d="M14.6 5.6 18.2 9.2l-3.6 3.6" /><path d="M19.4 14.8h-13" /><path d="M9.4 11.2 5.8 14.8l3.6 3.6" />`
    }
  },
  {
    id: 'tab-boxes',
    title: 'Containers',
    glyph: {
      kind: 'drawn',
      note: 'Containers: a crate seen from the front, a lid rule across it and two straps running the full height of the body. The first drawing was a square with a smaller square inside, which is the silhouette the scoped field wears, so the two were unreadable apart at 12px. The straps first stopped short of both edges and read as two loose bars in a box.',
      shapes: `<path d="M3.6 8.6h16.8v9.2a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2Z" /><path d="M3.6 8.6a2 2 0 0 1 2-2h12.8a2 2 0 0 1 2 2" />${solid(8.2, 8.6, 2, 11.2, 1)}${solid(13.8, 8.6, 2, 11.2, 1)}`
    }
  },
  {
    id: 'tab-extensions',
    title: 'Extensions tab',
    glyph: {
      kind: 'drawn',
      note: 'Extensions: a puzzle piece, one knob cut into the top edge and one knob solid on the right. The previous drawing was a square with a single knob and it read as a clipboard, which is reserved for the copy toast.',
      shapes: `<path d="M6.4 5.2h3.2a3 3 0 1 1 5 0h3.2v12.4H6.4Z" />${dot(18.4, 11.4, 2.8)}`
    }
  },
  {
    id: 'tab-files',
    title: 'Files tab',
    glyph: {
      kind: 'drawn',
      note: 'Files: two sheets with one solid line on the front sheet. The dock Workspace files is a folder tree; this one is the pages themselves, so the two never collide.',
      shapes: `<rect x="4.2" y="6.4" width="11" height="14" rx="2" /><path d="M8.2 6.4V6a2 2 0 0 1 2-2h7.2a2 2 0 0 1 2 2v10.6a2 2 0 0 1-2 2h-.4" />${solid(7, 11.6, 5.6, 2.4, 1.2)}`
    }
  },
  {
    id: 'tab-git',
    title: 'Git tab',
    glyph: {
      kind: 'drawn',
      note: 'Git: two commits on a stem and the branch that leaves from one of them, the head commit solid. The solid head is what makes it a branch rather than three dots.',
      shapes: `<circle cx="7" cy="6.4" r="2.4" /><circle cx="7" cy="17.6" r="2.4" />${dot(17, 9.6, 2.4)}<path d="M7 8.8v6.4" /><path d="M14.8 9.6h-3.6a4.2 4.2 0 0 0-4.2 4.2v1.4" />`
    }
  },
  {
    id: 'tab-info',
    title: 'Info tab',
    glyph: {
      kind: 'carried',
      note: "Update: a readout plate carrying its own mark. The dot and the stem are 1.8 units wide, above the one-device-pixel floor, which pass D's version of this glyph was not.",
      transform: 'translate(-2.5263 -2.5263) scale(1.2105)',
      scale: 1.2105,
      body: `<rect x="3.5" y="4.8" width="17" height="14.4" rx="2" /> <circle cx="12" cy="9.3" r="1.8" fill="currentColor" stroke="none" /> <rect x="11.1" y="12.4" width="1.8" height="4.8" rx="0.9" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'tab-settings',
    title: 'Settings',
    glyph: {
      kind: 'carried',
      note: 'Settings: two sliders, each handle solid, its track entering from both sides. The gap in the track is what stops the handle merging into it at 16px, which is exactly what happened in pass C. The gap is 1.6 units, which is just over one device pixel at rail size; a 1.2-unit gap vanished and the glyph became two plain bars.',
      transform: 'translate(-2.5263 -2.5263) scale(1.2105)',
      scale: 1.2105,
      body: `<path d="M3.5 8.6h2.9" /> <path d="M15 8.6h5.5" /> <rect x="8" y="6.9" width="5.4" height="3.4" rx="1.2" fill="currentColor" stroke="none" /> <path d="M3.5 15.4h5.5" /> <path d="M17.6 15.4h2.9" /> <rect x="10.6" y="13.7" width="5.4" height="3.4" rx="1.2" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'tab-tasks',
    title: 'Task manager',
    glyph: {
      kind: 'carried',
      note: 'Task manager: two running panels, one behind the other, the front one lit. Isometric planes and lanes were both tried first and both failed at 16px: the planes closed into a single downward point, and the lanes read as a list, which is what Thread already is. The panels overlap by 2 units so the offset is a visible step rather than two tiles touching.',
      transform: 'translate(-3.4286 -3.4286) scale(1.2857)',
      scale: 1.2857,
      body: `<rect x="7.8" y="3.8" width="12.7" height="7.8" rx="1.8" /> <rect x="3.5" y="9.6" width="12.7" height="8.8" rx="1.8" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'tab-utilities',
    title: 'Utilities',
    glyph: {
      kind: 'carried',
      note: 'Utilities: the four panels the utilities page actually is, a grid of skills, MCP servers and plugins.',
      transform: 'translate(-2.5263 -2.5263) scale(1.2105)',
      scale: 1.2105,
      body: `<rect x="3.5" y="3.5" width="7.4" height="7.4" rx="1.6" /> <rect x="13.1" y="3.5" width="7.4" height="7.4" rx="1.6" /> <rect x="3.5" y="13.1" width="7.4" height="7.4" rx="1.6" /> <rect x="13.1" y="13.1" width="7.4" height="7.4" rx="1.6" />`
    }
  },
  {
    id: 'tag',
    title: 'Tag',
    glyph: {
      kind: 'drawn',
      note: 'Tag: a label with its corner cut and a solid eyelet, which is what makes a tag read as tied on.',
      shapes: `<path d="M4.4 10.8V6a1.6 1.6 0 0 1 1.6-1.6h4.8l8.8 8.8-6.4 6.4Z" />${dot(8.4, 8.4, 1.9)}`
    }
  },
  {
    id: 'target',
    title: 'Goal',
    glyph: {
      kind: 'drawn',
      note: 'Goal: two rings around a solid centre, the inner ring at 4.4 units so it survives 12px.',
      shapes: `<circle cx="12" cy="12" r="8.2" /><circle cx="12" cy="12" r="4.4" />${dot(12, 12, 1.8)}`
    }
  },
  {
    id: 'team',
    title: 'Team',
    glyph: {
      kind: 'drawn',
      note: 'Team: two people, the one in front solid, which is a group of agents rather than a single account.',
      shapes: `<circle cx="16.6" cy="8" r="2.8" /><path d="M14.4 19.6a5.6 5.6 0 0 1 5.8-5.4" />${dot(9, 7.8, 3.4)}<path d="M3.4 19.6a5.6 5.6 0 0 1 11.2 0" />`
    }
  },
  {
    id: 'temporary-chat',
    title: 'Temporary chat',
    glyph: {
      kind: 'drawn',
      note: 'Temporary chat: the chat bubble with a bite out of its lower right, so it is the same object as Chats with one thing missing rather than a different object. A dashed outline was tried and the dashes fell under the 1.5-unit floor.',
      shapes: `<path d="M8.6 6.6H6.2a2.4 2.4 0 0 0-2.4 2.4v4.8a2.4 2.4 0 0 0 2.4 2.4h1.4l3.4 3v-3" /><path d="M14.8 6.6h2.8a2.4 2.4 0 0 1 2.4 2.4v2.2" />${solid(6.6, 10.6, 8.4, 2.6, 1.3)}`
    }
  },
  {
    id: 'terminal',
    title: 'Oven and terminal',
    glyph: {
      kind: 'drawn',
      note: 'Oven and terminal: a frame with a prompt and a solid cursor. The cursor is the anchor, and it is 2.4 units tall so it survives 12px as well as 16px.',
      shapes: `<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.4" /><path d="M7.6 9.4 10.4 12.2 7.6 15" />${solid(12, 12.6, 5.2, 2.6, 1.3)}`
    }
  },
  {
    id: 'thread-browser',
    title: 'Browser in a thread',
    glyph: {
      kind: 'solid',
      note: 'Browser in a thread: the browser mark itself, with a thread run as a bar from the centre to the right. The bar is one more subpath of the same even-odd path as the disc and the ring, so where it crosses the ring both are knocked out and the ring reads open on the right. The mark before it was a disc of its own with a crescent bitten out of it, which filled the circle and read as a smudge.',
      body: `<path fill="currentColor" fill-rule="evenodd" d="M0.700,12A11.300,11.300 0 1 1 23.300,12A11.300,11.300 0 1 1 0.700,12ZM3.504,8.217A9.300,7.000 24 0 0 20.496,15.783A9.300,7.000 24 0 0 3.504,8.217ZM11.0,10.95H21.6A0.95,0.95 0 0 1 21.6,12.85H11.0A0.95,0.95 0 0 1 11.0,10.95Z" />`
    }
  },
  {
    id: 'threads',
    title: 'Thread',
    glyph: {
      kind: 'carried',
      note: 'Thread: a spine of entries that shorten as they age, the live one solid.',
      transform: 'translate(-5.617 -5.617) scale(1.4681)',
      scale: 1.4681,
      body: `<path d="M5.4 7.2v9.6" /> <rect x="8.6" y="5.9" width="11.5" height="2.6" rx="1.3" fill="currentColor" stroke="none" /> <path d="M8.6 12h9.4" /> <path d="M8.6 16.4h6" />`
    }
  },
  {
    id: 'timer-off',
    title: 'Expired',
    glyph: {
      kind: 'drawn',
      note: 'Expired: the clock struck through, its hands still solid so it stays readable underneath.',
      shapes: `<circle cx="12" cy="12" r="8.2" />${solid(11, 7.4, 2, 4.6, 1)}${solid(12.4, 11, 3.6, 2, 1)}<path d="M5.4 18.6 18.6 5.4" />`
    }
  },
  {
    id: 'tools',
    title: 'Tools',
    glyph: {
      kind: 'drawn',
      note: 'Tools: a socket spanner. This is the spec studio toggle, so it has to read as engineering work rather than as an office. The case Lucide draws is a box with a handle on it, which is what luggage looks like.',
      shapes: `<path d="M20.2 5.6 17.9 9.6H13.3L11 5.6l2.3-4h4.6Z" />${dot(15.6, 5.6, 1.9)}<path d="M10.7 7.1 13.1 9.5 5.7 16.9 3.3 14.5Z" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'trash',
    title: 'Delete',
    glyph: {
      kind: 'drawn',
      note: 'Delete: a bin with a lid rule, a handle and one solid rib. Two ribs turned the body into a smudge at 16px; one keeps the ribs reading as ribs.',
      shapes: `<path d="M4.4 7.4h15.2" /><path d="M9.6 7.4V5.6a1.4 1.4 0 0 1 1.4-1.4h2a1.4 1.4 0 0 1 1.4 1.4v1.8" /><path d="M6.8 7.4 7.8 19a2 2 0 0 0 2 1.8h4.4a2 2 0 0 0 2-1.8l1-11.6" />${solid(11, 10.6, 2, 6.2, 1)}`
    }
  },
  {
    id: 'undo',
    title: 'Undo',
    glyph: {
      kind: 'drawn',
      note: 'Undo: a ring broken by a corner on the left, the mirror of refresh, which is how the two are told apart at 12px.',
      shapes: `<path d="M4.4 12a7.6 7.6 0 1 0 2.3-5.4" /><path d="M4.4 4.4v4.4h4.4" />`
    }
  },
  {
    id: 'unplug',
    title: 'Disconnected',
    glyph: {
      kind: 'drawn',
      note: 'Disconnected: the same plug with its prongs struck out, so the two read as one object in two states.',
      shapes: `${solid(9.4, 3.6, 2, 4.8, 1)}${solid(12.6, 3.6, 2, 4.8, 1)}<rect x="6.4" y="8.6" width="11.2" height="6.4" rx="2" /><path d="M12 15v5.4" /><path d="M5 20 19 4.4" />`
    }
  },
  {
    id: 'upload',
    title: 'Upload',
    glyph: {
      kind: 'drawn',
      note: 'Upload: the download turned over, with the same solid shaft so the two read as one gesture in two directions.',
      shapes: `${solid(10.9, 8.4, 2.2, 7.6, 1.1)}<path d="M7.4 9.4 12 4.8l4.6 4.6" /><path d="M4.4 18.4v.8a1.4 1.4 0 0 0 1.4 1.4h12.4a1.4 1.4 0 0 0 1.4-1.4v-.8" />`
    }
  },
  {
    id: 'variable',
    title: 'Variable',
    glyph: {
      kind: 'drawn',
      note: 'Variable: a slot carrying a cross, which is the mark for a value the action leaves open.',
      shapes: `<rect x="3.4" y="6.2" width="17.2" height="11.6" rx="2.2" /><path d="M9.6 9.8 14.4 14.2" /><path d="M14.4 9.8 9.6 14.2" />`
    }
  },
  {
    id: 'volume',
    title: 'Sound on',
    glyph: {
      kind: 'drawn',
      note: 'Sound on: a speaker with a solid mouth and two waves, spaced so they stay apart at 12px.',
      shapes: `<path d="M4.6 9.4h3.6L12.8 5.4v13.2l-4.6-4H4.6Z" />${solid(6.2, 10.4, 3, 3.2, 1.2)}<path d="M16.2 9.6a3.6 3.6 0 0 1 0 4.8" /><path d="M18.8 7.2a7 7 0 0 1 0 9.6" />`
    }
  },
  {
    id: 'volume-x',
    title: 'Sound off',
    glyph: {
      kind: 'drawn',
      note: 'Sound off: the same speaker with the waves replaced by a cross, so the two are one control in two states.',
      shapes: `<path d="M4.6 9.4h3.6L12.8 5.4v13.2l-4.6-4H4.6Z" />${solid(6.2, 10.4, 3, 3.2, 1.2)}<path d="M16.2 9.8 20.6 14.2" /><path d="M20.6 9.8 16.2 14.2" />`
    }
  },
  {
    id: 'window',
    title: 'Window',
    glyph: {
      kind: 'drawn',
      note: 'Window: a frame with a title rule and two solid controls, which is what makes it a window rather than a card.',
      shapes: `<rect x="3.4" y="4.8" width="17.2" height="14.4" rx="2" /><path d="M3.4 9.4h17.2" />${dot(6.8, 7.1, 1.2)}${dot(9.6, 7.1, 1.2)}`
    }
  },
  {
    id: 'wrench',
    title: 'Repair',
    glyph: {
      kind: 'drawn',
      note: 'Repair: an open-ended spanner. The jaw is a ring with its mouth cut at the far end and the shaft leaves the ring at its back, so the two read as one struck thing. Two earlier drawings failed: three loose strokes with the jaw closed read as a broken compass, and a ring the shaft ran into read as a magnifier, which is the search mark.',
      shapes: `<g transform="rotate(-45 12 12)"><rect x="4.8" y="10.3" width="8.4" height="3.4" rx="1.7" fill="currentColor" stroke="none" /></g><path d="M16.3 4.7a4 4 0 1 0 3 3" />`
    }
  },
  {
    id: 'zap',
    title: 'Instant',
    glyph: {
      kind: 'drawn',
      note: 'Instant: a solid bolt. It is one of the few glyphs that is entirely solid, because a stroked bolt closes up at 12px.',
      shapes: `<path d="M13.6 3.6 5.8 13.4h5l-.4 7 7.8-9.8h-5Z" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'activity',
    title: 'Activity',
    glyph: {
      kind: 'drawn',
      note: 'Activity: one line that rises, dips and recovers, which is a heartbeat rather than a chart. A column set said "a measure"; the trace says "a thing still alive".',
      shapes: `<path d="M3.4 12.4h3.4l2.2-6.6 3.2 12.4 2.6-8.2h5.8" />`
    }
  },
  {
    id: 'arrow-down',
    title: 'Down',
    glyph: {
      kind: 'drawn',
      note: 'Down: the up mark turned over, so a pair of controls reads as one gesture either way.',
      shapes: `<path d="M12 4.6v14.8" /><path d="M5.8 13.2 12 19.4l6.2-6.2" />`
    }
  },
  {
    id: 'arrow-left-to-line',
    title: 'To the start',
    glyph: {
      kind: 'drawn',
      note: 'To the start: the back arrow run into a wall, which is the beginning of a run rather than one step back.',
      shapes: `<path d="M4.6 5.4v13.2" /><path d="M20.4 12H7.2" /><path d="M13.4 5.8 7.2 12l6.2 6.2" />`
    }
  },
  {
    id: 'arrow-right-to-line',
    title: 'To the end',
    glyph: {
      kind: 'drawn',
      note: 'To the end: the mirror of the start mark, arrow into wall.',
      shapes: `<path d="M19.4 5.4v13.2" /><path d="M3.6 12h13.2" /><path d="M10.6 5.8l6.2 6.2-6.2 6.2" />`
    }
  },
  {
    id: 'arrow-up-circle',
    title: 'Send in a ring',
    glyph: {
      kind: 'drawn',
      note: 'Send in a ring: the send arrow held in a ring, because the surface it sits on moves something out rather than up.',
      shapes: `<circle cx="12" cy="12" r="8.2" /><path d="M12 16.6V8.2" /><path d="M8.6 11.4 12 8l3.4 3.4" />`
    }
  },
  {
    id: 'arrow-up-down',
    title: 'Sort',
    glyph: {
      kind: 'drawn',
      note: 'Sort: one arrow up and one down on the same baseline, which is a choice of order rather than a direction.',
      shapes: `<path d="M8.4 19.4V4.6" /><path d="M4.6 8.4 8.4 4.6l3.8 3.8" /><path d="M15.6 4.6v14.8" /><path d="M11.8 15.6 15.6 19.4l3.8-3.8" />`
    }
  },
  {
    id: 'audio-lines',
    title: 'Sound',
    glyph: {
      kind: 'drawn',
      note: 'Sound: five bars of alternating height on one centre line, which is a waveform. Nothing else in the set is a band of vertical bars.',
      shapes: `<path d="M3.6 10.2v3.6" /><path d="M7.8 6.4v11.2" /><path d="M12 8.8v6.4" /><path d="M16.2 4.8v14.4" /><path d="M20.4 10.2v3.6" />`
    }
  },
  {
    id: 'battery-charging',
    title: 'Charging',
    glyph: {
      kind: 'drawn',
      note: 'Charging: a cell with a bolt in it, the bolt solid so it survives the smallest size a gauge is drawn at.',
      shapes: `<rect x="3.4" y="7.4" width="15.6" height="9.2" rx="2" /><path d="M21.4 10.6v2.8" /><path d="M12.4 8.8 8.8 13h3l-.8 3 3.6-4.4h-3Z" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'battery-medium',
    title: 'Half used',
    glyph: {
      kind: 'drawn',
      note: 'Half used: the same cell with one solid block in it, which is a level rather than a charge.',
      shapes: `<rect x="3.4" y="7.4" width="15.6" height="9.2" rx="2" /><path d="M21.4 10.6v2.8" /><rect x="6.2" y="10.2" width="5.4" height="3.6" rx="1.2" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'bell-off',
    title: 'Muted',
    glyph: {
      kind: 'drawn',
      note: 'Muted: the bell struck through, the bell kept whole underneath so it still reads as the bell turned off.',
      shapes: `<path d="M6.4 16.4v-5a5.6 5.6 0 0 1 11.2 0v5" /><path d="M4.6 16.4h14.8" /><path d="M12 5.8V4.2" /><path d="M4.4 19.6 19.6 4.4" />`
    }
  },
  {
    id: 'bookmark-check',
    title: 'Saved',
    glyph: {
      kind: 'drawn',
      note: 'Saved: the ribbon with a check where the tab was, which is a bookmark that has landed rather than one held.',
      shapes: `<path d="M6.4 4.4h11.2a1.6 1.6 0 0 1 1.6 1.6v14.2l-7.2-4.4-7.2 4.4V6a1.6 1.6 0 0 1 1.6-1.6Z" /><path d="M9.2 10.4 11.4 12.6 15.2 8.4" />`
    }
  },
  {
    id: 'calendar',
    title: 'Date',
    glyph: {
      kind: 'drawn',
      note: 'Date: a frame with its header inked and two hangers, which is a calendar at a glance. The band is the mass; the day grid dies at 16px.',
      shapes: `<rect x="3.4" y="5.4" width="17.2" height="15.2" rx="2" /><rect x="3.4" y="5.4" width="17.2" height="4.8" rx="2" fill="currentColor" stroke="none" /><path d="M8.2 3.4v4" /><path d="M15.8 3.4v4" />`
    }
  },
  {
    id: 'calendar-clock',
    title: 'Scheduled',
    glyph: {
      kind: 'drawn',
      note: 'Scheduled: the clock set inside the calendar rather than over its corner, so no stroke of one crosses the other. The clock the first pass hung over the edge put its ring through the calendar frame.',
      shapes: `<rect x="3.4" y="5.4" width="17.2" height="15.2" rx="2" /><rect x="3.4" y="5.4" width="17.2" height="4.8" rx="2" fill="currentColor" stroke="none" /><path d="M8.2 3.4v4" /><path d="M15.8 3.4v4" /><circle cx="15.6" cy="15.2" r="3.6" /><circle cx="15.6" cy="15.2" r="0.9" fill="currentColor" stroke="none" /><path d="M15.6 13.2v2" /><path d="M15.6 15.2h1.6" />`
    }
  },
  {
    id: 'calendar-off',
    title: 'No date',
    glyph: {
      kind: 'drawn',
      note: 'No date: the calendar struck through, its header band kept so it is still the calendar underneath.',
      shapes: `<rect x="3.4" y="5.4" width="17.2" height="15.2" rx="2" /><rect x="3.4" y="5.4" width="17.2" height="4.8" rx="2" fill="currentColor" stroke="none" /><path d="M8.2 3.4v4" /><path d="M15.8 3.4v4" /><path d="M4.4 19.6 19.6 4.4" />`
    }
  },
  {
    id: 'calendar-plus',
    title: 'Add a date',
    glyph: {
      kind: 'drawn',
      note: 'Add a date: the calendar with a plus in the day area, the plus solid the way every other plus in the set is.',
      shapes: `<rect x="3.4" y="5.4" width="17.2" height="15.2" rx="2" /><rect x="3.4" y="5.4" width="17.2" height="4.8" rx="2" fill="currentColor" stroke="none" /><path d="M8.2 3.4v4" /><path d="M15.8 3.4v4" /><rect x="11" y="11.6" width="2" height="7" rx="1" fill="currentColor" stroke="none" /><rect x="8.5" y="14.1" width="7" height="2" rx="1" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'captions',
    title: 'Captions',
    glyph: {
      kind: 'drawn',
      note: 'Captions: a screen with one solid line of text along the bottom, which is subtitles rather than a message.',
      shapes: `<rect x="3.4" y="5.4" width="17.2" height="13.2" rx="2" /><rect x="6.6" y="14.2" width="10.8" height="2.2" rx="1.1" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'case-sensitive',
    title: 'Match case',
    glyph: {
      kind: 'drawn',
      note: 'Match case: the two letters the control is about, drawn in strokes so they read at 16px where real glyphs turn to mush.',
      shapes: `<path d="M3.6 17.6 7.6 7.6l4 10" /><path d="M5.2 13.8h4.8" /><circle cx="17.4" cy="14.4" r="3.2" /><path d="M20.6 11.2v6.4" />`
    }
  },
  {
    id: 'check-check',
    title: 'All done',
    glyph: {
      kind: 'drawn',
      note: 'All done: two checks in a rank, the second set lower, which is one acceptance behind another.',
      shapes: `<path d="M2.8 11.6 6.4 15.2 13.2 6.6" /><path d="M11.6 15.2 15.2 18.8 22 10.2" />`
    }
  },
  {
    id: 'chevrons-down',
    title: 'Expand all',
    glyph: {
      kind: 'drawn',
      note: 'Expand all: two chevrons stacked, which is a whole list opening rather than one row.',
      shapes: `<path d="M6.8 6.4 12 11.6l5.2-5.2" /><path d="M6.8 12.4 12 17.6l5.2-5.2" />`
    }
  },
  {
    id: 'chevrons-up',
    title: 'Collapse all',
    glyph: {
      kind: 'drawn',
      note: 'Collapse all: the same pair turned over.',
      shapes: `<path d="M6.8 11.6 12 6.4l5.2 5.2" /><path d="M6.8 17.6 12 12.4l5.2 5.2" />`
    }
  },
  {
    id: 'clipboard-list',
    title: 'Question list',
    glyph: {
      kind: 'drawn',
      note: 'Question list: the clipboard with its solid clip and three lines, which is a set of things to answer.',
      shapes: `<path d="M8.6 4.8H6.4a1.8 1.8 0 0 0-1.8 1.8v12a1.8 1.8 0 0 0 1.8 1.8h11.2a1.8 1.8 0 0 0 1.8-1.8v-12a1.8 1.8 0 0 0-1.8-1.8h-2.2" /><rect x="9.2" y="3.4" width="5.6" height="3" rx="1.3" fill="currentColor" stroke="none" /><rect x="7.8" y="11" width="8.4" height="2" rx="1" fill="currentColor" stroke="none" /><rect x="7.8" y="14.6" width="5.6" height="2" rx="1" fill="currentColor" stroke="none" /><rect x="7.8" y="18.2" width="7" height="2" rx="1" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'clipboard-x',
    title: 'Nothing to paste',
    glyph: {
      kind: 'drawn',
      note: 'Nothing to paste: the clipboard with a cross where the lines were, which is an empty hand rather than an empty board.',
      shapes: `<path d="M8.6 4.8H6.4a1.8 1.8 0 0 0-1.8 1.8v12a1.8 1.8 0 0 0 1.8 1.8h11.2a1.8 1.8 0 0 0 1.8-1.8v-12a1.8 1.8 0 0 0-1.8-1.8h-2.2" /><rect x="9.2" y="3.4" width="5.6" height="3" rx="1.3" fill="currentColor" stroke="none" /><path d="M9.8 11.6 14.2 16" /><path d="M14.2 11.6 9.8 16" />`
    }
  },
  {
    id: 'cloud-off',
    title: 'No remote',
    glyph: {
      kind: 'drawn',
      note: 'No remote: the cloud struck through, which is a remote that could not be reached rather than one that is absent.',
      shapes: `<path d="M7.4 18.4a4.2 4.2 0 0 1-.6-8.4 5.6 5.6 0 0 1 10.8 1.2 3.6 3.6 0 0 1-.4 7.2Z" /><path d="M4.4 19.6 19.6 4.4" />`
    }
  },
  {
    id: 'cookie',
    title: 'Cookies',
    glyph: {
      kind: 'drawn',
      note: 'Cookies: a disc with bitten edges and a few solid chips, which is a site storing something rather than a plain setting.',
      shapes: `<path d="M12 3.6a8.4 8.4 0 1 0 8.4 8.4 4.2 4.2 0 0 1-4.2-4.2A4.2 4.2 0 0 1 12 3.6Z" /><circle cx="9.4" cy="9.6" r="1.4" fill="currentColor" stroke="none" /><circle cx="13.6" cy="13.4" r="1.4" fill="currentColor" stroke="none" /><circle cx="9" cy="15" r="1.4" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'cursor',
    title: 'Pointer',
    glyph: {
      kind: 'drawn',
      note: 'Pointer: the arrow the machine actually draws, with its tail, which is a shape nothing else in the set has.',
      shapes: `<path d="M6.4 3.6 19.6 12.4l-6.4 1.2-2.6 5.8Z" />`
    }
  },
  {
    id: 'eraser',
    title: 'Erase',
    glyph: {
      kind: 'drawn',
      note: 'Erase: a block laid on the diagonal with the corner it has already cleared, which is rubbing out rather than deleting.',
      shapes: `<path d="M8.6 4.6a2 2 0 0 1 2.8 0l6.6 6.6-6 6H7l-2.6-2.6a2 2 0 0 1 0-2.8Z" /><path d="M10.6 19.8h9" />`
    }
  },
  {
    id: 'file',
    title: 'File',
    glyph: {
      kind: 'drawn',
      note: 'File: the plain page, which is the mark every other file in the set is built on.',
      shapes: `<path d="M5.4 5.4a1.6 1.6 0 0 1 1.6-1.6h6.4l5 5v10.2a1.6 1.6 0 0 1-1.6 1.6H7a1.6 1.6 0 0 1-1.6-1.6Z" /><path d="M13.4 3.8v5.2h5" />`
    }
  },
  {
    id: 'file-audio',
    title: 'Audio file',
    glyph: {
      kind: 'drawn',
      note: 'Audio file: the page carrying one note, its head, stem and runout meeting at the stem so the three strokes read as a single mark rather than as pieces laid on the page.',
      shapes: `<path d="M5.4 5.4a1.6 1.6 0 0 1 1.6-1.6h6.4l5 5v10.2a1.6 1.6 0 0 1-1.6 1.6H7a1.6 1.6 0 0 1-1.6-1.6Z" /><path d="M13.4 3.8v5.2h5" /><circle cx="11.4" cy="16.4" r="2" fill="currentColor" stroke="none" /><rect x="13.2" y="9.4" width="2" height="7" rx="1" fill="currentColor" stroke="none" /><path d="M15.2 9.4a3.2 3.2 0 0 1 2.4 3.1" />`
    }
  },
  {
    id: 'file-check',
    title: 'Checked file',
    glyph: {
      kind: 'drawn',
      note: 'Checked file: the page with a check, which is work that has been read and accepted.',
      shapes: `<path d="M5.4 5.4a1.6 1.6 0 0 1 1.6-1.6h6.4l5 5v10.2a1.6 1.6 0 0 1-1.6 1.6H7a1.6 1.6 0 0 1-1.6-1.6Z" /><path d="M13.4 3.8v5.2h5" /><path d="M8.4 13.4 10.8 15.8 15.4 11" />`
    }
  },
  {
    id: 'file-minus',
    title: 'File removed',
    glyph: {
      kind: 'drawn',
      note: 'File removed: the page with one solid bar, the same bar the text marks use, which is a line taken out.',
      shapes: `<path d="M5.4 5.4a1.6 1.6 0 0 1 1.6-1.6h6.4l5 5v10.2a1.6 1.6 0 0 1-1.6 1.6H7a1.6 1.6 0 0 1-1.6-1.6Z" /><path d="M13.4 3.8v5.2h5" /><rect x="8.4" y="13.6" width="7.2" height="2" rx="1" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'file-pen',
    title: 'File edited',
    glyph: {
      kind: 'drawn',
      note: 'File edited: the page with a pen laid in its lower half, kept inside the page so the two never read as two marks.',
      shapes: `<path d="M5.4 5.4a1.6 1.6 0 0 1 1.6-1.6h6.4l5 5v10.2a1.6 1.6 0 0 1-1.6 1.6H7a1.6 1.6 0 0 1-1.6-1.6Z" /><path d="M13.4 3.8v5.2h5" /><path d="M8.8 15.4 14.2 10a1.8 1.8 0 0 1 2.6 2.6l-5.4 5.4H8.8Z" />`
    }
  },
  {
    id: 'file-plus',
    title: 'New file',
    glyph: {
      kind: 'drawn',
      note: 'New file: the page with the set’s solid plus on it, so it stands beside the folder plus as one idea.',
      shapes: `<path d="M5.4 5.4a1.6 1.6 0 0 1 1.6-1.6h6.4l5 5v10.2a1.6 1.6 0 0 1-1.6 1.6H7a1.6 1.6 0 0 1-1.6-1.6Z" /><path d="M13.4 3.8v5.2h5" /><rect x="11" y="11" width="2" height="7" rx="1" fill="currentColor" stroke="none" /><rect x="8.5" y="13.5" width="7" height="2" rx="1" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'file-question',
    title: 'File to answer',
    glyph: {
      kind: 'drawn',
      note: 'File to answer: the page with a question mark on it, the same stem and dot the attention marks use.',
      shapes: `<path d="M5.4 5.4a1.6 1.6 0 0 1 1.6-1.6h6.4l5 5v10.2a1.6 1.6 0 0 1-1.6 1.6H7a1.6 1.6 0 0 1-1.6-1.6Z" /><path d="M13.4 3.8v5.2h5" /><path d="M9.6 11.4a2.4 2.4 0 1 1 2.8 2.4v1.8" /><circle cx="12.4" cy="18" r="1.2" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'file-warning',
    title: 'File alert',
    glyph: {
      kind: 'drawn',
      note: 'File alert: the page carrying the warning stem and dot, which is the same alert the triangle and the ring carry.',
      shapes: `<path d="M5.4 5.4a1.6 1.6 0 0 1 1.6-1.6h6.4l5 5v10.2a1.6 1.6 0 0 1-1.6 1.6H7a1.6 1.6 0 0 1-1.6-1.6Z" /><path d="M13.4 3.8v5.2h5" /><path d="M12 10.6v4.6" /><circle cx="12" cy="18" r="1.2" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'flag',
    title: 'Flag',
    glyph: {
      kind: 'drawn',
      note: 'Flag: a pole with its pennant inked, which is something marked for attention rather than a bookmark.',
      shapes: `<path d="M6.2 3.6v16.8" /><path d="M6.2 4.8h11.4l-2.8 4 2.8 4H6.2Z" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'folder-git',
    title: 'Repository',
    glyph: {
      kind: 'drawn',
      note: 'Repository: the folder with a branch mark inside it, which is a checkout rather than a directory.',
      shapes: `<path d="M3.6 17.6V7.2a1.8 1.8 0 0 1 1.8-1.8h4l2.2 2.8h7a1.8 1.8 0 0 1 1.8 1.8v7.6a1.8 1.8 0 0 1-1.8 1.8H5.4a1.8 1.8 0 0 1-1.8-1.8Z" /><circle cx="9.4" cy="11.6" r="1.8" /><rect x="8.5" y="13.4" width="1.8" height="3.4" rx="0.9" fill="currentColor" stroke="none" /><circle cx="15.4" cy="15" r="1.8" /><path d="M15.4 13.2v-1" /><path d="M11.2 11.6h2.4a1.8 1.8 0 0 1 1.8 1.8v1.6" />`
    }
  },
  {
    id: 'frame',
    title: 'Frame',
    glyph: {
      kind: 'drawn',
      note: 'Frame: two rules each way, which is a crop or a bounding box rather than a panel with a side.',
      shapes: `<path d="M4.6 7.4h14.8" /><path d="M4.6 16.6h14.8" /><path d="M7.4 4.6v14.8" /><path d="M16.6 4.6v14.8" />`
    }
  },
  {
    id: 'heart-pulse',
    title: 'Health',
    glyph: {
      kind: 'drawn',
      note: 'Health: a heartbeat inside an outline, the trace kept to three strokes so the two marks do not fight at 16px.',
      shapes: `<path d="M12 19.6 4.8 12.4a4.4 4.4 0 0 1 6.2-6.2l1 1 1-1a4.4 4.4 0 0 1 6.2 6.2Z" /><path d="M6.6 12.6h2.6l1.4-2.6 2.2 5.2 1.4-2.6h3.4" />`
    }
  },
  {
    id: 'home',
    title: 'Home',
    glyph: {
      kind: 'drawn',
      note: 'Home: a roof over a door, the door solid, which is where a workspace starts rather than a folder.',
      shapes: `<path d="M3.8 11.4 12 3.8l8.2 7.6" /><path d="M5.8 10.6v9.2h12.4v-9.2" /><rect x="10.4" y="13.6" width="3.2" height="6.2" rx="1.2" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'image',
    title: 'Image',
    glyph: {
      kind: 'drawn',
      note: 'Image: a frame with the sky and a ridge in it, which is a picture rather than a screen.',
      shapes: `<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2" /><path d="M4.4 17.6 9.8 12.2l3.6 3.6 2.6-2.6 3.6 3.6" /><circle cx="8.6" cy="9.4" r="1.6" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'image-plus',
    title: 'Add an image',
    glyph: {
      kind: 'drawn',
      note: 'Add an image: the picture standing beside the solid plus rather than carrying it, so neither the frame nor the plus gives up its shape to the other.',
      shapes: `<rect x="3.4" y="4.6" width="11.2" height="14.8" rx="2" /><circle cx="7" cy="8.8" r="1.4" fill="currentColor" stroke="none" /><path d="M4.4 16.8 7.8 13.4l2.2 2.2 1.6-1.6" /><rect x="17" y="11.6" width="2" height="8" rx="1" fill="currentColor" stroke="none" /><rect x="14.6" y="14.6" width="6.8" height="2" rx="1" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'inbox',
    title: 'Inbox',
    glyph: {
      kind: 'drawn',
      note: 'Inbox: a tray with its lip, which is where things arrive rather than a drawer they were put in.',
      shapes: `<path d="M3.6 13.4 6.2 5.2h11.6l2.6 8.2v4.2a2.2 2.2 0 0 1-2.2 2.2H5.8a2.2 2.2 0 0 1-2.2-2.2Z" /><path d="M3.6 13.4h4.6l1.4 2.4h4.8l1.4-2.4h4.6" />`
    }
  },
  {
    id: 'layout-grid',
    title: 'Grid',
    glyph: {
      kind: 'drawn',
      note: 'Grid: four even panels, one inked, which is a layout choice rather than a board of columns.',
      shapes: `<rect x="3.6" y="3.6" width="7.2" height="7.2" rx="1.8" /><rect x="13.2" y="3.6" width="7.2" height="7.2" rx="1.8" /><rect x="3.6" y="13.2" width="7.2" height="7.2" rx="1.8" /><rect x="13.2" y="13.2" width="7.2" height="7.2" rx="1.8" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'lightbulb',
    title: 'Idea',
    glyph: {
      kind: 'drawn',
      note: 'Idea: a bulb with a solid filament, which is a thought offered rather than a sparkle.',
      shapes: `<path d="M12 3.6a6 6 0 0 1 3.6 10.8c-.8.6-1.2 1.4-1.3 2.4H9.7c-.1-1-.5-1.8-1.3-2.4A6 6 0 0 1 12 3.6Z" /><path d="M9.8 19.4h4.4" /><circle cx="12" cy="10.4" r="2" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'list-checks',
    title: 'Checklist',
    glyph: {
      kind: 'drawn',
      note: 'Checklist: three rungs on a spine, the top one a check, which is a list of work with something already done.',
      shapes: `<path d="M5.4 6.4v11.2" /><path d="M8.8 7.6 10.8 9.6 14.6 5.8" /><path d="M8.8 13.2h10.4" /><path d="M8.8 17.6h7" />`
    }
  },
  {
    id: 'list-clock',
    title: 'List with a clock',
    glyph: {
      kind: 'drawn',
      note: 'List with a clock: the list holding a small clock, which is a list that runs on a timer.',
      shapes: `<path d="M3.6 6.6h16.8" /><path d="M3.6 11.8h6.4" /><path d="M3.6 17h6.4" /><circle cx="16.4" cy="15.6" r="4.6" /><circle cx="16.4" cy="15.6" r="1.1" fill="currentColor" stroke="none" /><path d="M16.4 13.6v2" /><path d="M16.4 15.6h1.8" />`
    }
  },
  {
    id: 'list-ordered',
    title: 'Numbered list',
    glyph: {
      kind: 'drawn',
      note: 'Numbered list: rungs with the numerals drawn as strokes, because a solid dot would make it the plain list.',
      shapes: `<path d="M9.4 6.6h11" /><path d="M9.4 12h11" /><path d="M9.4 17.4h11" /><path d="M4.2 5.4 6 4.6v4.2" /><path d="M3.8 11a1.4 1.4 0 0 1 2.8 0c0 1-2.8 1.8-2.8 3.4h2.8" /><path d="M3.8 16.2h2.6l-1.6 1.6c1 .1 1.6.6 1.6 1.4a1.5 1.5 0 0 1-2.6.9" />`
    }
  },
  {
    id: 'log-in',
    title: 'Sign in',
    glyph: {
      kind: 'drawn',
      note: 'Sign in: a doorway with the arrow entering it, which is a session starting.',
      shapes: `<path d="M13.4 4.4H6.6a2 2 0 0 0-2 2v11.2a2 2 0 0 0 2 2h6.8" /><path d="M18.4 12H9.6" /><path d="M14.8 8l4 4-4 4" />`
    }
  },
  {
    id: 'log-out',
    title: 'Sign out',
    glyph: {
      kind: 'drawn',
      note: 'Sign out: the same doorway with the arrow leaving, the mirror of the sign-in mark.',
      shapes: `<path d="M10.6 4.4h6.8a2 2 0 0 1 2 2v11.2a2 2 0 0 1-2 2h-6.8" /><path d="M14.4 12H5.6" /><path d="M9.2 8l-4 4 4 4" />`
    }
  },
  {
    id: 'marquee',
    title: 'Select an area',
    glyph: {
      kind: 'drawn',
      note: 'Select an area: a dashed box with the pointer at its corner, because a solid box would be the square mark.',
      shapes: `<path d="M4.4 4.4h3.2" /><path d="M10.4 4.4h3.2" /><path d="M16.4 4.4h3.2" /><path d="M19.6 7.4v3.2" /><path d="M19.6 13.4v3.2" /><path d="M4.4 7.4v3.2" /><path d="M4.4 13.4v3.2" /><path d="M16.4 19.6h3.2" /><path d="M10.4 19.6h3.2" /><path d="M4.4 19.6h3.2" /><path d="M8.6 8.6 18.4 15l-4.6 1-2 4.6Z" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'moon',
    title: 'Dark',
    glyph: {
      kind: 'drawn',
      note: 'Dark: a crescent, which is the one shape that says night without a second element. It pairs with the sun.',
      shapes: `<path d="M20.4 14.4A8.4 8.4 0 0 1 9.6 3.6a8.4 8.4 0 1 0 10.8 10.8Z" />`
    }
  },
  {
    id: 'panel-left',
    title: 'Panel left',
    glyph: {
      kind: 'drawn',
      note: 'Panel left: the framed panel with its bar on the left, the mirror of the panel-right mark.',
      shapes: `<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2" /><path d="M9.8 4.6v14.8" /><rect x="3.4" y="4.6" width="6.4" height="14.8" rx="2" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'panels-left-bottom',
    title: 'Split left and bottom',
    glyph: {
      kind: 'drawn',
      note: 'Split left and bottom: a frame divided once down the left and once across the bottom, which is a three-pane layout.',
      shapes: `<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2" /><path d="M9.6 4.6v14.8" /><path d="M3.4 13.8h17.2" /><rect x="3.4" y="4.6" width="6.2" height="9.2" rx="2" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'pin-off',
    title: 'Unpin',
    glyph: {
      kind: 'drawn',
      note: 'Unpin: the pin laid on its side with the stroke through it, which is the pin let go rather than a pin absent.',
      shapes: `<path d="M8.4 4.6h7.2" /><path d="M9.8 4.6v6.2l-2.4 3.6h9.2l-2.4-3.6V4.6" /><path d="M12 14.4v4.8" /><path d="M4.4 19.6 19.6 4.4" />`
    }
  },
  {
    id: 'pull-request-closed',
    title: 'Pull request closed',
    glyph: {
      kind: 'drawn',
      note: 'Pull request closed: the pull request with its feed closed by a cross, which is a change refused rather than taken.',
      shapes: `<circle cx="6.4" cy="6.4" r="2.6" /><rect x="5.4" y="9" width="2" height="8.6" rx="1" fill="currentColor" stroke="none" /><circle cx="17.4" cy="17.6" r="2.6" /><path d="M17.4 15V9" /><path d="M14.6 4.4 20.4 10.2" /><path d="M20.4 4.4 14.6 10.2" />`
    }
  },
  {
    id: 'pull-request-draft',
    title: 'Pull request draft',
    glyph: {
      kind: 'drawn',
      note: 'Pull request draft: the pull request with its head node left open, which is the same change with nothing put up for review yet. Dashing the ring in short strokes, as the first pass did, read as a mistake at 16px.',
      shapes: `<circle cx="6.6" cy="6.4" r="2.6" stroke-dasharray="2.6 2" /><rect x="5.6" y="9" width="2" height="8.6" rx="1" fill="currentColor" stroke="none" /><path d="M17.4 15.4V12a3.4 3.4 0 0 0-3.4-3.4H10.6" /><path d="M13.4 6.2 10.4 8.6l3 2.4" /><circle cx="17.4" cy="18" r="2.4" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'rows-3',
    title: 'Rows',
    glyph: {
      kind: 'drawn',
      note: 'Rows: one frame ruled into three bands, which is a stacked layout rather than a column set.',
      shapes: `<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2" /><path d="M3.4 9.6h17.2" /><path d="M3.4 14.4h17.2" />`
    }
  },
  {
    id: 'scissors',
    title: 'Cut',
    glyph: {
      kind: 'drawn',
      note: 'Cut: two blades crossing into two rings, which is the shape a cut has had since it was drawn.',
      shapes: `<circle cx="6.4" cy="6.6" r="2.8" /><circle cx="6.4" cy="17.4" r="2.8" /><path d="M8.8 8 20.4 18.4" /><path d="M8.8 16 20.4 5.6" />`
    }
  },
  {
    id: 'shapes',
    title: 'Shapes',
    glyph: {
      kind: 'drawn',
      note: 'Shapes: a triangle and a square across the top with the disc sitting under them, so the ink fills the box. The first pass left the disc high on the right, which emptied the lower left and made the whole mark lean.',
      shapes: `<path d="M8 3.8 12.8 11.8H3.2Z" /><rect x="13.2" y="3.8" width="8" height="8" rx="1.8" /><circle cx="12" cy="17.4" r="3.6" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'shield',
    title: 'Shield',
    glyph: {
      kind: 'drawn',
      note: 'Shield: the plain crest, which is the mark the checked and alerted shields are drawn from.',
      shapes: `<path d="M12 3.6 19.4 6.6v6.2c0 3.9-2.9 7.1-7.4 8.4-4.5-1.3-7.4-4.5-7.4-8.4V6.6Z" />`
    }
  },
  {
    id: 'shield-off',
    title: 'Unguarded',
    glyph: {
      kind: 'drawn',
      note: 'Unguarded: the crest struck through, the crest kept whole underneath so the shape still reads.',
      shapes: `<path d="M12 3.6 19.4 6.6v6.2c0 3.9-2.9 7.1-7.4 8.4-4.5-1.3-7.4-4.5-7.4-8.4V6.6Z" /><path d="M4.4 19.6 19.6 4.4" />`
    }
  },
  {
    id: 'skip-back',
    title: 'Skip back',
    glyph: {
      kind: 'drawn',
      note: 'Skip back: the skip mark mirrored, its bar on the left, so the pair reads as one transport either way.',
      shapes: `<rect x="6" y="6.4" width="2.4" height="11.2" rx="1.2" fill="currentColor" stroke="none" /><path d="M17.6 6.4 10 12l7.6 5.6Z" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'smile-plus',
    title: 'Add a reaction',
    glyph: {
      kind: 'drawn',
      note: 'Add a reaction: a face with the solid plus at its shoulder, which is a reaction being put on rather than a face alone.',
      shapes: `<circle cx="11.4" cy="12.6" r="7.8" /><circle cx="8.6" cy="10.6" r="1.2" fill="currentColor" stroke="none" /><circle cx="14.2" cy="10.6" r="1.2" fill="currentColor" stroke="none" /><path d="M8.4 15.2a4.4 4.4 0 0 0 6 0" /><rect x="18.4" y="3.6" width="2" height="6.4" rx="1" fill="currentColor" stroke="none" /><rect x="16.2" y="5.8" width="6.4" height="2" rx="1" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'square',
    title: 'Stop box',
    glyph: {
      kind: 'drawn',
      note: 'Square: the sheet’s own frame with nothing in it, which is a region rather than the solid stop the transport draws.',
      shapes: `<rect x="4.4" y="4.4" width="15.2" height="15.2" rx="2" />`
    }
  },
  {
    id: 'sun',
    title: 'Light',
    glyph: {
      kind: 'drawn',
      note: 'Light: a disc with eight even rays, the pair of the crescent.',
      shapes: `<circle cx="12" cy="12" r="4.4" /><path d="M12 2.8v2.4" /><path d="M12 18.8v2.4" /><path d="M2.8 12h2.4" /><path d="M18.8 12h2.4" /><path d="M5.5 5.5 7.2 7.2" /><path d="M16.8 16.8 18.5 18.5" /><path d="M18.5 5.5 16.8 7.2" /><path d="M7.2 16.8 5.5 18.5" />`
    }
  },
  {
    id: 'select-all',
    title: 'Select all',
    glyph: {
      kind: 'drawn',
      note: 'Select all: a frame with everything inside it inked, which is the whole of a thing taken rather than a caret sitting in it. The I-beam it was said where the cursor goes, not what the command does.',
      shapes: `<rect x="4.4" y="4.4" width="15.2" height="15.2" rx="2" /><rect x="7.2" y="7.2" width="9.6" height="9.6" rx="1.4" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'thermometer',
    title: 'Heat',
    glyph: {
      kind: 'drawn',
      note: 'Heat: a stem into a bulb, the bulb solid, which is load rather than a measure of time.',
      shapes: `<path d="M13.8 13.8V5.6a2.8 2.8 0 0 0-5.6 0v8.2a4.6 4.6 0 1 0 5.6 0Z" /><circle cx="11" cy="16.4" r="1.9" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'thumbs-up',
    title: 'Approved',
    glyph: {
      kind: 'drawn',
      note: 'Approved: a hand with the thumb up over a solid cuff, which is a review given rather than a check made.',
      shapes: `<path d="M7.6 10.6 10.8 3.8a2.2 2.2 0 0 1 2.9 2.9l-1.3 3.3h4.9a2 2 0 0 1 2 2.4l-1.2 6a2 2 0 0 1-2 1.6H7.6" /><rect x="3.4" y="10.6" width="4.2" height="9.4" rx="1.6" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'timer-reset',
    title: 'Timer reset',
    glyph: {
      kind: 'drawn',
      note: 'Timer reset: the ring opened into a cycle at its upper left with the set hands in the middle, which is the retry ring with a reading on it. The dial the first pass drew was a dot and a corner, which read as damage.',
      shapes: `<path d="M4.4 12a7.6 7.6 0 1 0 2.3-5.4" /><path d="M4.4 4.6v4.4h4.4" /><rect x="11" y="8.4" width="2" height="4.2" rx="1" fill="currentColor" stroke="none" /><rect x="12.4" y="11.4" width="3.2" height="2" rx="1" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'wrap-text',
    title: 'Wrap text',
    glyph: {
      kind: 'drawn',
      note: 'Wrap text: three rules where the middle one turns back on itself, which is a line folding rather than a column set.',
      shapes: `<path d="M4.4 6h15.2" /><path d="M4.4 11.4h10.4a3.2 3.2 0 0 1 0 6.4H12" /><path d="M4.4 18.6h6" /><path d="M14.2 15.4 11.8 17.8l2.4 2.4" />`
    }
  },
  {
    id: 'zoom-in',
    title: 'Zoom in',
    glyph: {
      kind: 'drawn',
      note: 'Zoom in: the lens with a solid plus in it, so it reads as a search being narrowed rather than a plain find.',
      shapes: `<circle cx="10.6" cy="10.6" r="6.8" /><path d="M15.6 15.6 20.4 20.4" /><rect x="9.6" y="6.6" width="2" height="8" rx="1" fill="currentColor" stroke="none" /><rect x="6.6" y="9.6" width="8" height="2" rx="1" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'zoom-out',
    title: 'Zoom out',
    glyph: {
      kind: 'drawn',
      note: 'Zoom out: the same lens with one solid bar, which is a search being widened.',
      shapes: `<circle cx="10.6" cy="10.6" r="6.8" /><path d="M15.6 15.6 20.4 20.4" /><rect x="6.6" y="9.6" width="8" height="2" rx="1" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'snail',
    title: 'Slow',
    glyph: {
      kind: 'drawn',
      note: 'Slow: a shell with the creature under it. A clock says what time it is and a spanner says a setting; the snail is the only mark that says a thing is taking too long.',
      shapes: `<circle cx="10.4" cy="11.4" r="5.4" /><circle cx="10.4" cy="11.4" r="1.5" fill="currentColor" stroke="none" /><path d="M3.6 17.4h15.6" /><path d="M16.8 17.4v-3.6" /><circle cx="16.8" cy="12.6" r="1.5" fill="currentColor" stroke="none" /><path d="M18.6 10.8 16.8 12.6" />`
    }
  },
  {
    id: 'store',
    title: 'Marketplace',
    glyph: {
      kind: 'drawn',
      note: 'Marketplace: a shop front with its awning inked and a door cut into it, which is somewhere things are offered rather than a box they were shipped in.',
      shapes: `<path d="M4.6 10.4v8a1.8 1.8 0 0 0 1.8 1.8h11.2a1.8 1.8 0 0 0 1.8-1.8v-8" /><rect x="3.4" y="6" width="17.2" height="4.4" rx="1.4" fill="currentColor" stroke="none" /><rect x="10.4" y="14.4" width="3.2" height="5.8" rx="1.2" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'git-graph',
    title: 'Commit graph',
    glyph: {
      kind: 'drawn',
      note: 'Commit graph: a trunk with two nodes and a branch curving off to a third, which is history as a shape. The clock the retry mark owns says when, not what happened.',
      shapes: `<path d="M7.6 4.6v14.8" /><circle cx="7.6" cy="7.6" r="1.9" fill="currentColor" stroke="none" /><circle cx="7.6" cy="16.4" r="1.9" fill="currentColor" stroke="none" /><path d="M7.6 12h4.6a3.8 3.8 0 0 0 3.8-3.8V7.6" /><circle cx="16" cy="7.6" r="1.9" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'git-compare',
    title: 'Compare',
    glyph: {
      kind: 'drawn',
      note: 'Compare: two panes read side by side, each carrying one solid line at a different height, which is what makes them two versions rather than two files. The crossing arrows said only that two directions exist.',
      shapes: `<rect x="3.6" y="4.6" width="7.2" height="14.8" rx="1.8" /><rect x="13.2" y="4.6" width="7.2" height="14.8" rx="1.8" /><rect x="5.6" y="8" width="3.2" height="1.8" rx="0.9" fill="currentColor" stroke="none" /><rect x="15.2" y="12.6" width="3.2" height="1.8" rx="0.9" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'git-compare-arrows',
    title: 'Compare across',
    glyph: {
      kind: 'drawn',
      note: 'Compare across: the two panes with arrows passing between them, which is a comparison that moves a change from one side to the other.',
      shapes: `<rect x="3.4" y="4.6" width="6.2" height="14.8" rx="1.8" /><rect x="14.4" y="4.6" width="6.2" height="14.8" rx="1.8" /><path d="M10 9.6h4" /><path d="M12.2 7.8 14 9.6l-1.8 1.8" /><path d="M14 14.4h-4" /><path d="M11.8 12.6 10 14.4l1.8 1.8" />`
    }
  },
  {
    id: 'git-merge-conflict',
    title: 'Merge conflict',
    glyph: {
      kind: 'drawn',
      note: 'Merge conflict: the branch coming down into its node with a close at its head, which is the close any version control system draws for it. The merge struck out said a join was refused rather than that two lines could not be read together.',
      shapes: `<path d="M6.4 11.4v9" /><path d="M8.6 3.8 4.2 8.2" /><path d="M8.6 8.2 4.2 3.8" /><path d="M12.4 6h3a2.6 2.6 0 0 1 2.6 2.6v6.6" /><circle cx="18" cy="17.8" r="2.5" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'list-todo',
    title: 'To do',
    glyph: {
      kind: 'drawn',
      note: 'To do: a spine whose top rung is an open box and whose other rungs are rules, which is a list with something still owed on it. The thread mark carries no box, so it reads as a record rather than as work.',
      shapes: `<path d="M5.4 7.4v10.2" /><rect x="8.6" y="4.8" width="4.4" height="4.4" rx="1.3" /><path d="M8.6 12.4h10.4" /><path d="M8.6 16.8h7" />`
    }
  },
  {
    id: 'list-tree',
    title: 'Tree list',
    glyph: {
      kind: 'drawn',
      note: 'Tree list: a root rung with a spine down from it and two indented rungs, which is a hierarchy read as a list. The workspace tree keeps its own folder mark; this is the shape of the indentation itself.',
      shapes: `<rect x="4.6" y="5.5" width="4.6" height="2.2" rx="1.1" fill="currentColor" stroke="none" /><path d="M7.2 7.7v9.2" /><path d="M7.2 11h4" /><path d="M7.2 15.8h4" /><rect x="11.2" y="9.9" width="9" height="2.2" rx="1.1" fill="currentColor" stroke="none" /><rect x="11.2" y="14.7" width="7" height="2.2" rx="1.1" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'plug-zap',
    title: 'Powered',
    glyph: {
      kind: 'drawn',
      note: 'Powered: the plug with a bolt beside it, which is a connection that carries energy rather than one that is merely made.',
      shapes: `<rect x="6.6" y="4.4" width="2" height="4.4" rx="1" /><rect x="9.8" y="4.4" width="2" height="4.4" rx="1" /><rect x="3.6" y="8.8" width="11.2" height="6.4" rx="2" /><path d="M9.2 15.2v5" /><path d="M20.4 4.6 16.2 10.8h3.2l-2.4 6.2 4.6-6.6h-3.2Z" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'replace',
    title: 'Replace',
    glyph: {
      kind: 'drawn',
      note: 'Replace: a row being taken out over a row going in, the outgoing one dashed, which is one thing swapped for another in place.',
      shapes: `<rect x="4.4" y="4.6" width="15.2" height="6" rx="2" stroke-dasharray="3 2.2" /><rect x="4.4" y="13.4" width="15.2" height="6" rx="2" /><path d="M12 11.2v2" /><path d="M10.4 11.6 12 13.2l1.6-1.6" />`
    }
  },
  {
    id: 'replace-all',
    title: 'Replace all',
    glyph: {
      kind: 'drawn',
      note: 'Replace all: the same swap run down a column, one row going and two already in, which is a replacement made everywhere rather than once.',
      shapes: `<rect x="4.4" y="3.6" width="15.2" height="4.8" rx="1.8" stroke-dasharray="3 2.2" /><rect x="4.4" y="9.6" width="15.2" height="4.8" rx="1.8" /><rect x="4.4" y="15.6" width="15.2" height="4.8" rx="1.8" />`
    }
  },
  {
    id: 'server-crash',
    title: 'Server down',
    glyph: {
      kind: 'drawn',
      note: 'Server down: the bays with their lamps and a close struck into the lower one, the close drawn as two solid bars so it reads at the size the mark is used at. Two strokes were too thin to say it.',
      shapes: `<rect x="3.4" y="4.4" width="17.2" height="6.4" rx="2" /><circle cx="7.4" cy="7.6" r="1.4" fill="currentColor" stroke="none" /><rect x="3.4" y="13.2" width="17.2" height="6.4" rx="2" /><circle cx="7.4" cy="16.4" r="1.4" fill="currentColor" stroke="none" /><g transform="rotate(45 17.4 16.4)"><rect x="14.9" y="15.3" width="5" height="2.2" rx="1.1" fill="currentColor" stroke="none" /></g><g transform="rotate(-45 17.4 16.4)"><rect x="14.9" y="15.3" width="5" height="2.2" rx="1.1" fill="currentColor" stroke="none" /></g>`
    }
  },
  {
    id: 'search-x',
    title: 'No match',
    glyph: {
      kind: 'drawn',
      note: 'No match: the lens with a cross in place of its hub, which is a search that came back with nothing rather than one that is still running.',
      shapes: `<circle cx="10.4" cy="10.4" r="6.2" /><path d="M15.2 15.2 20.4 20.4" /><path d="M8.2 8.2 12.6 12.6" /><path d="M12.6 8.2 8.2 12.6" />`
    }
  },
  {
    id: 'shredder',
    title: 'Shred',
    glyph: {
      kind: 'drawn',
      note: 'Shred: a sheet feeding into a solid machine head with the strips it has made falling out below it, which is a document destroyed from that line onward rather than a bin holding one.',
      shapes: `<rect x="7.4" y="3.6" width="9.2" height="7.4" rx="1.2" /><rect x="4.4" y="11" width="15.2" height="3.2" rx="1.2" fill="currentColor" stroke="none" /><path d="M7.8 14.2v4.4" /><path d="M12 14.2v5.8" /><path d="M16.2 14.2v4.4" />`
    }
  },
  {
    id: 'trending-up',
    title: 'Rising',
    glyph: {
      kind: 'drawn',
      note: 'Rising: a line that steps down once and then climbs away, closed by a corner at its head, which is a direction of travel rather than a column set measured.',
      shapes: `<path d="M3.4 17.6 8.8 12.2l3.6 3.6 7.8-7.8" /><path d="M15 7.4h5.2v5.2" />`
    }
  },
  {
    id: 'user-check',
    title: 'Verified person',
    glyph: {
      kind: 'drawn',
      note: 'Verified person: the account with a check beside its head, so the mark carries the same acceptance every other check carries.',
      shapes: `<circle cx="9.4" cy="7" r="4" /><path d="M3.4 20.4a6 6 0 0 1 12 0" /><path d="M14.8 6.6 17 8.8 21.4 4.2" />`
    }
  },
  {
    id: 'user-minus',
    title: 'Removed person',
    glyph: {
      kind: 'drawn',
      note: 'Removed person: the same account with a solid bar where the check would be, which is an access taken away rather than an account that is simply there.',
      shapes: `<circle cx="9.4" cy="7" r="4" /><path d="M3.4 20.4a6 6 0 0 1 12 0" /><rect x="15.2" y="6" width="6" height="2" rx="1" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'wifi-off',
    title: 'Offline',
    glyph: {
      kind: 'drawn',
      note: 'Offline: the wireless arcs with the stroke through them. A plug being pulled says a cable, and this has to say the network was never reached.',
      shapes: `<path d="M8.4 15.2a5.4 5.4 0 0 1 7.2 0" /><path d="M5.2 11.8a10.4 10.4 0 0 1 13.6 0" /><circle cx="12" cy="18.8" r="1.5" fill="currentColor" stroke="none" /><path d="M4.4 19.6 19.6 4.4" />`
    }
  },
  {
    id: 'documents',
    title: 'Files',
    glyph: {
      kind: 'drawn',
      note: 'Files: two pages, the front one folded at its corner and the back one showing behind, which is a set of documents rather than the workspace tree the folder mark owns.',
      shapes: `<path d="M8.6 4.4h5.6l4.4 4.4v9.4a1.6 1.6 0 0 1-1.6 1.6H8.6a1.6 1.6 0 0 1-1.6-1.6V6a1.6 1.6 0 0 1 1.6-1.6Z" /><path d="M14.2 4.4v4.4h4.4" /><path d="M4.6 7.6v10.4a2.4 2.4 0 0 0 2.4 2.4h7.4" />`
    }
  },
  {
    id: 'package-plus',
    title: 'Package added',
    glyph: {
      kind: 'drawn',
      note: 'Package added: the box with the solid plus set in its lower right facet, clear of the fold lines so nothing doubles up, which is a package being added rather than one that exists.',
      shapes: `<path d="M4.4 8.6 12 4.6l7.6 4v6.8L12 19.4l-7.6-4Z" /><path d="M4.4 8.6 12 12.6l7.6-4" /><path d="M12 12.6v6.8" /><rect x="9.6" y="6.2" width="4.8" height="1.8" rx="0.9" fill="currentColor" stroke="none" /><rect x="15.1" y="11.6" width="1.6" height="4.8" rx="0.8" fill="currentColor" stroke="none" /><rect x="13.5" y="13.2" width="4.8" height="1.6" rx="0.8" fill="currentColor" stroke="none" />`
    }
  },
  {
    id: 'package-check',
    title: 'Package checked',
    glyph: {
      kind: 'drawn',
      note: 'Package checked: the same facet carrying a check, which is a package that has arrived and been accepted.',
      shapes: `<path d="M4.4 8.6 12 4.6l7.6 4v6.8L12 19.4l-7.6-4Z" /><path d="M4.4 8.6 12 12.6l7.6-4" /><path d="M12 12.6v6.8" /><rect x="9.6" y="6.2" width="4.8" height="1.8" rx="0.9" fill="currentColor" stroke="none" /><path d="M14 14.4 15.8 16.2 18.4 13.2" />`
    }
  },
  {
    id: 'bug-off',
    title: 'Debug off',
    glyph: {
      kind: 'drawn',
      note: 'Debug off: the debugger mark struck through, which is the debugger turned off rather than a debugger that is not there. Reusing the plain mark said the opposite of what the control does.',
      shapes: `<rect x="6" y="7.4" width="12" height="12" rx="6" /><path d="M6 10.6H3.6" /><path d="M6 16.4H3.6" /><path d="M18 10.6h2.4" /><path d="M18 16.4h2.4" /><rect x="8.6" y="12.2" width="6.8" height="2.6" rx="1.3" fill="currentColor" stroke="none" /><path d="M4.4 19.6 19.6 4.4" />`
    }
  },
  {
    id: 'cable',
    title: 'Cable',
    glyph: {
      kind: 'drawn',
      note: 'Cable: a plug with its cord running away from it, which is a lead rather than a socket. The plug mark says a connection is made; this says what is running to it.',
      shapes: `<rect x="15" y="3.4" width="1.8" height="4" rx="0.9" fill="currentColor" stroke="none" /><rect x="17.6" y="3.4" width="1.8" height="4" rx="0.9" fill="currentColor" stroke="none" /><rect x="13.4" y="7.4" width="7.6" height="6.4" rx="2" /><path d="M13.4 13.8c-4.8 0-8.4 1.4-8.4 6.6" />`
    }
  },
  {
    id: 'ellipsis-vertical',
    title: 'More, upright',
    glyph: {
      kind: 'drawn',
      note: 'More, upright: the same three dots stood up, for a toolbar that stacks its controls rather than laying them out.',
      shapes: `<circle cx="12" cy="6.4" r="1.9" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.9" fill="currentColor" stroke="none" /><circle cx="12" cy="17.6" r="1.9" fill="currentColor" stroke="none" />`
    }
  }
]
