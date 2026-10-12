<script lang="ts">
  import type { Attachment } from 'svelte/attachments'

  let { attach }: { attach: Attachment<HTMLDivElement> } = $props()
</script>

<!-- A mounted Svelte root installs delegation for the live nodes moved here. -->
<div data-native-floating-root {@attach attach}></div>
