# Oven fonts on your website

Copy this entire directory into your website, retaining OFL.txt beside the fonts.
These full-coverage variable WOFF2 files include the same glyphs as the app.

```html
<link rel="stylesheet" href="/fonts/oven/fonts.css" />
```

Use the official wordmark style for the product name:

```html
<h1 class="cio-wordmark">CodeInOven</h1>
```

The class sets Oven Mono at weight 800. Keep Oven Box for the app's interface
font and choose a family explicitly for each website surface.

```css
body {
  font-family: 'Oven Box', ui-monospace, monospace;
  font-weight: 400;
}
code,
pre {
  font-family: inherit;
}
/* The other available face is Oven Mono. */
```

Oven Box supports weights 200–800; Oven Mono supports 300–800. Both currently
provide upright styles; browsers synthesize italics if requested. Use normal
font-weight values; the fonts interpolate between weights.

For installable variable TTF files, see docs/designs/brand-typeface/fonts/.
The fonts are distributed under the SIL Open Font License 1.1 in OFL.txt.
