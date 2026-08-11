<script lang="ts">
  import { Server } from '@lucide/svelte'
  import type { CloudDeploymentProviderKind } from '$shared/types'
  import CoolifyIcon from './CoolifyIcon.svelte'
  import NetlifyIcon from './NetlifyIcon.svelte'
  import RailwayIcon from './RailwayIcon.svelte'
  import VercelIcon from './VercelIcon.svelte'
  import DokployIcon from './DokployIcon.svelte'

  interface Props {
    /** The cloud deployment provider kind to render a brand mark for. */
    providerKind: CloudDeploymentProviderKind
    /** Icon edge length in px. */
    size?: number
    /** Fill color for monochrome brand marks. Defaults to currentColor. */
    color?: string
    class?: string
    /** Accessibility title shown as `<title>`; when absent the icon is aria-hidden. */
    title?: string
  }

  let { providerKind, size = 14, color, class: className, title }: Props = $props()
</script>

<!--
  Brand mark for a cloud deployment provider. Known providers render their
  own logo (Coolify / Netlify / Railway / Vercel / Dokploy); anything without
  a bundled mark falls back to the generic Server glyph.
-->
{#if providerKind === 'coolify'}
  <CoolifyIcon {size} {color} {title} class={className} />
{:else if providerKind === 'netlify'}
  <NetlifyIcon {size} {color} {title} class={className} />
{:else if providerKind === 'railway'}
  <RailwayIcon {size} {color} {title} class={className} />
{:else if providerKind === 'vercel'}
  <VercelIcon {size} {color} {title} class={className} />
{:else if providerKind === 'dokploy'}
  <DokployIcon {size} {color} {title} class={className} />
{:else}
  <Server {size} class={className} {color} />
{/if}
