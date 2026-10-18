# CIO icon direction

This guide records how CodeInOven icons should be drawn, refined, reviewed, and added. The set is a product voice, not a collection of generic symbols. Each mark should read quickly at the size where it is used, feel related to the rest of the set, and keep its own recognizable silhouette.

## The visual language

### Draw for the product

- Start with the meaning and the actual UI context. Choose a silhouette that communicates that job at a glance.
- Make a CIO drawing of your own. Do not trace or copy Lucide or another icon set. A familiar visual idea is fine; the geometry and construction should belong to CIO.
- Prefer a clear outer shape and a small number of useful interior marks. Remove a stroke when it repeats information or makes the icon rough at 16px.
- Compare related states side by side. For example, open and closed, enabled and disabled, or copied and not copied should share a base construction where that helps them read as a family.
- Do not add decoration just to fill space. Every stroke or solid mass should explain the icon's meaning or help its balance.

### Stroke and geometry

- Draw inside a `24 × 24` SVG viewBox. The generator fits picture glyphs to a 22-unit ink box, and directional indicators to a 14-unit box.
- Use an effective stroke width of `1.8` units. The generated component accepts the call site's stroke width and compensates for its fit scale so the requested weight stays consistent.
- Square caps and miter joins are the default. Rocket is the deliberate rounded-line exception. Solid marks, including the Browser mark, have no stroke.
- Square off rectangular and semi-square forms when it suits the object. Use sharp corners for frames, panels, clipboards, tools, and other built shapes. Keep circles circular when roundness carries meaning, such as status dots, hubs, or the shape of a living or organic subject.
- Do not replace every curve with a corner. Curves belong where they describe a genuinely round or organic form. The Browser mark is its own solid disc-and-ring drawing and remains unchanged by the stroke pass.
- For solid anchors, use a compact mass that remains visible at small sizes. Anchors have no stroke. The generated drawing can bind them to `--icon-anchor` when a state needs an accent; the default remains `currentColor`.
- Keep the smallest meaningful gap and stroke visible at 16px. Inspect at the actual use size as well as the 24-unit source viewBox.

### Fit and balance

- Draw a glyph in a local coordinate box, then let the generator fit it around its ink center. Do not make one icon larger by hand to compensate for a poor neighboring fit.
- Keep proportions intentional. A directional mark should read as a control indicator, not as a full-size picture beside other icons.
- Judge optical balance, not just mathematical centering. The fit is measured, but a purposeful silhouette may still need a reviewed per-icon fit override.
- Avoid strokes or gaps below the set's practical small-size floor. If detail collapses at 16px, simplify the drawing rather than relying on a larger display size.

## Adding an icon

1. Add a `GlyphEntry` to `scripts/icons/cio-drawings.ts`. Give it a stable kebab-case `id`, a concise user-facing `title`, and a `note` that records what the symbol means and any meaningful construction choice.
2. Choose the right source form:
   - `drawn` for new stroked artwork. Provide the SVG `shapes` in its local coordinates and set `indicator: true` only for a directional control mark.
   - `carried` only when preserving an existing reviewed drawing whose geometry should remain intact while the generator refits it.
   - `solid` for a mark whose meaning depends on filled geometry rather than a stroke.
3. Use the shared `solid(...)` and `dot(...)` helpers for solid anchors when they fit the drawing. Do not hand-edit generated Svelte components.
4. Run `bun run icons:build` from the repository root. This regenerates package components, the app registry, and the contact sheet, then checks that icon imports resolve.
5. Review the new glyph beside related icons and its shipping baseline. Inspect it at 16px and at its actual product size, in light and dark surfaces where relevant. Check its silhouette, spacing, caps, joins, small solid areas, and accessibility behavior at its call site.
6. Refine the source drawing, rebuild, and repeat until the mark reads cleanly. Keep exceptions explicit in the generator and review material. Do not broaden a global rule to fix one icon if a targeted source correction is safer.
7. Run the relevant scoped Svelte check for changed app components and package output. Commit the canonical drawing source and generated outputs together.

## Review standard

Before accepting an icon, ask:

- Can someone identify it at 16px without relying on its label?
- Does its silhouette remain distinct beside similar icons?
- Does every stroke add meaning or structure?
- Are built rectangular forms square where that makes sense, while meaningful circles and organic curves stay round?
- Are anchors and gaps large enough to survive at small sizes?
- Does it feel like CIO when placed next to neighboring glyphs?
- Does the generated component preserve its fit, requested stroke weight, `currentColor`, and accessible naming behavior?

If any answer is no, revise the drawing before adding the icon to a surface.

## Source of truth

`scripts/icons/cio-drawings.ts` is the canonical icon artwork. `scripts/icons/build-icons.ts` defines fitting, shared component behavior, and construction exceptions. `packages/cio-icons/src/lib/` and `src/renderer/lib/components/icons/cio/` are generated output. Edit the source and generator, then run the build. Do not patch generated files by hand.
