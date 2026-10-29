<script lang="ts">
  /**
   * What the conversation shows while its transcript is on its way.
   *
   * It is deliberately *not* an overlay, a second column or a floating block: it
   * is rendered inside the same `mx-auto ... max-w-3xl ... gap-4` container the
   * messages will be rendered into, so its width, gutters and bottom anchoring
   * are the conversation's own. The rows it stands in for are the three that
   * carry the answer the user came back for: the prompt, the folded work trace,
   * and the response.
   *
   * Because it sits in the real container, the swap to real messages is a
   * replacement in place: nothing moves, nothing is uncovered, and there is no
   * frame where an empty message container exists.
   */
</script>

<div class="animate-pulse space-y-6" aria-hidden="true" data-conversation-skeleton>
  <!-- The prompt the turn was started from. -->
  <div class="space-y-2">
    <div class="h-3 w-[58%] bg-overlay"></div>
    <div class="h-3 w-[34%] bg-overlay/70"></div>
  </div>

  <!-- The folded work trace: its gutter rule, its label and its measure. -->
  <div class="flex items-center gap-2">
    <div class="h-4 w-px shrink-0 bg-border"></div>
    <div class="h-3 w-24 bg-overlay"></div>
    <div class="h-3 w-9 bg-overlay/50"></div>
  </div>

  <!-- The response. -->
  <div class="space-y-2.5">
    <div class="h-3 w-[93%] bg-overlay/80"></div>
    <div class="h-3 w-[88%] bg-overlay/70"></div>
    <div class="h-3 w-[96%] bg-overlay/60"></div>
    <div class="h-3 w-[64%] bg-overlay/50"></div>
  </div>
</div>
