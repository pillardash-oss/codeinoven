# @codeinoven/icons

The handcrafted CodeInOven icon set, distributed as tree-shakeable Svelte 5 components.

```svelte
<script lang="ts">
  import { CioArchive } from '@codeinoven/icons'
</script>

<CioArchive size={20} aria-label="Archive" role="img" />
```

Components use `currentColor`, accept a `size`, `strokeWidth`, and standard SVG attributes, and keep decorative icons hidden from assistive technology unless given an accessible name. Solid anchor shapes can inherit `--icon-anchor` to support state-driven accent color.

The canonical drawings live in `scripts/icons/cio-drawings.ts`. Run `bun run icons:build` from the CodeInOven repository to regenerate the package source before building or publishing it.
