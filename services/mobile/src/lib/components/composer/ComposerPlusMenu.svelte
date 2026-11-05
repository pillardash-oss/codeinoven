<script lang="ts">
  import CioDisk from '@pdslng/cio-icon/CioDisk.svelte'
  import CioPaperclip from '@pdslng/cio-icon/CioPaperclip.svelte'

  /**
   * The plus menu, exactly as the desktop draws it: the File System switch this
   * message runs with, a rule, and the way to attach files. Every item writes to
   * the thread, so nothing here is a placeholder.
   */
  interface Props {
    fileSystem: boolean
    /** True while a send or an upload is in flight, so attaching cannot race it. */
    busy?: boolean
    onfilesystem: () => void
    onattach: () => void
  }

  let { fileSystem, busy = false, onfilesystem, onattach }: Props = $props()
</script>

<div class="cpanel plus-menu" role="menu" aria-label="Chat options">
  <button
    class="cpanel-switch"
    type="button"
    role="switch"
    aria-checked={fileSystem}
    title="Let this message read and write the project's files"
    onclick={onfilesystem}
  >
    <span class="ms-name"><CioDisk size={13} /> File System</span>
    <span class="sw" aria-hidden="true"></span>
  </button>
  <div class="cpanel-sep" aria-hidden="true"></div>
  <button
    class="cpanel-item"
    type="button"
    role="menuitem"
    disabled={busy}
    title="Attach files to this message"
    onclick={onattach}
  >
    <CioPaperclip size={13} />
    Attach Files
  </button>
</div>
