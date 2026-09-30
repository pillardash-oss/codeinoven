<script lang="ts">
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import { APP_NAME } from '$shared/brand'

  /**
   * The one-time start-at-login offer.
   *
   * Raised in the one moment the question has a reason to exist: right after a
   * routine is given its first how-to, so its runs are something its owner is
   * expecting. Rendering the question is all this owns. Whether it is raised at
   * all is decided in the main process, which reads the `launchAtLoginPrompted`
   * flag, so the question is put once in an install's life and never again for
   * any later routine setup.
   *
   * Both ways out are answers: `Not now` and a dismissal (backdrop, Escape) mean
   * the same thing, which is why the choice is saved with the flag on either
   * path instead of being asked again.
   */
  interface Props {
    open: boolean
    /** `true` starts the app at login; `false` leaves it off. */
    onChoose: (startAtLogin: boolean) => void
  }

  let { open, onChoose }: Props = $props()
</script>

<ConfirmDialog
  {open}
  title="Start {APP_NAME} at login?"
  confirmLabel="Start at login"
  cancelLabel="Not now"
  variant="primary"
  onConfirm={() => onChoose(true)}
  onCancel={() => onChoose(false)}
>
  <p>
    Your first routine is set up. Routines only fire while {APP_NAME} is running, so starting it at login
    lets a scheduled run still happen after a restart or a fresh sign in.
  </p>
  <p>You can change this any time in Settings.</p>
</ConfirmDialog>
