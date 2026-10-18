<script lang="ts">let { size = 16, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
export {};
</script>

<!--
  CIO · Browser
  Planet and ring: disc, tilted ring gap, planet inside
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
  <path
    fill="currentColor"
    fill-rule="evenodd"
    d="M0.700,12A11.300,11.300 0 1 1 23.300,12A11.300,11.300 0 1 1 0.700,12ZM3.504,8.217A9.300,7.000 24 0 0 20.496,15.783A9.300,7.000 24 0 0 3.504,8.217ZM5.422,9.071A7.200,5.419 24 0 0 18.578,14.929A7.200,5.419 24 0 0 5.422,9.071Z"
  />
</svg>
