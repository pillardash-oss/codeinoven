<script lang="ts">
  import { X } from '@lucide/svelte'
  import { noticeDismissals } from '$lib/stores/notice-dismissals.svelte'

  /**
   * The one dismiss control for a notice banner.
   *
   * Every notice in the app closes the same way and holds the same way, so the
   * button owns the remembering: `id` names the notice and `condition`
   * fingerprints what it is currently about. A dismissal survives every remount
   * of the notice's host and expires on its own the moment the condition
   * changes, which is why a call site never keeps its own dismissed flag.
   *
   * The call site pairs `id` and `condition` with
   * `noticeDismissals.isDismissed(id, condition)` to decide whether to draw the
   * notice at all, so both values are repeated at the guard. Keep them adjacent
   * to each other in the markup.
   */
  interface Props {
    /** Stable identity of the notice, scoped so the same notice raised in two
     *  projects (or two panels) is dismissed independently. */
    id: string
    /** Signature of the condition behind the notice: the text it is about. A
     *  dismissal only holds while this stays the same. */
    condition: string
    /** Action-specific label, required so no call site can ship an unlabelled
     *  icon button. It is both the tooltip and the accessible name. */
    title: string
    /** `sm` for the dense rows in the git status panel, `md` for full notices. */
    size?: 'sm' | 'md'
    /** `danger` for the error bands, so the affordance matches the severity. */
    tone?: 'default' | 'danger'
  }

  let { id, condition, title, size = 'md', tone = 'default' }: Props = $props()
</script>

<button
  type="button"
  class="flex shrink-0 items-center justify-center transition-colors {size === 'sm'
    ? 'h-6 w-6 rounded-md'
    : 'h-7 w-7 rounded-lg'} {tone === 'danger'
    ? 'text-danger hover:bg-danger/10'
    : 'text-dimmed hover:bg-elevated hover:text-foreground'}"
  {title}
  aria-label={title}
  onclick={() => noticeDismissals.dismiss(id, condition)}
>
  <X size={size === 'sm' ? 12 : 13} aria-hidden="true" />
</button>
