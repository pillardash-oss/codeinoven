<script lang="ts">
  import { Bell } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'

  /**
   * A manual test surface for the app's notifications.
   *
   * The app draws every toast through svelte-sonner's shared `toast` object,
   * which the app-errors store wraps so each error also lands in the errors
   * panel; the native overlay projects the same stack over a browser page. That
   * makes appearance and behaviour easy to regress without noticing, so this
   * panel raises one card per state the app supports, in place, from the About
   * page. It changes no production behaviour: every button calls the same API a
   * real call site uses.
   */

  interface ToastProbe {
    /** The button's own label. */
    label: string
    /** The action-specific tooltip the button carries. */
    title: string
    /** Raise the notification this button stands for. */
    run: () => void
  }

  interface ToastProbeGroup {
    heading: string
    probes: ToastProbe[]
  }

  /** A plain wait, so the promise states have something to resolve against. */
  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  }

  const groups: ToastProbeGroup[] = [
    {
      heading: 'Status',
      probes: [
        {
          label: 'Success',
          title: 'Show a success notification',
          run: () => toast.success('Project saved')
        },
        {
          label: 'Error',
          title: 'Show an error notification',
          run: () => toast.error('The project could not be saved')
        },
        {
          label: 'Warning',
          title: 'Show a warning notification',
          run: () => toast.warning('This file has unsaved changes')
        },
        {
          label: 'Info',
          title: 'Show an info notification',
          run: () => toast.info('A new version is available')
        }
      ]
    },
    {
      heading: 'Plain',
      probes: [
        {
          label: 'Message',
          title: 'Show a plain message notification',
          run: () => toast.message('Someone is typing')
        }
      ]
    },
    {
      heading: 'Loading and promise',
      probes: [
        {
          label: 'Loading',
          title: 'Show a loading notification that closes on its own',
          run: () => toast.loading('Preparing the workspace…')
        },
        {
          label: 'Loading (sticky)',
          title: 'Show a loading notification that never times out',
          run: () =>
            toast.loading('Waiting for a background task…', {
              duration: Number.POSITIVE_INFINITY
            })
        },
        {
          label: 'Promise resolved',
          title: 'Show a promise notification that resolves to success',
          run: () => {
            void toast.promise(delay(2000), {
              loading: 'Applying changes…',
              success: 'Changes applied'
            })
          }
        },
        {
          label: 'Promise rejected',
          title: 'Show a promise notification that rejects to an error',
          run: () => {
            void toast.promise(
              delay(2000).then(() => {
                throw new Error('The remote refused the request')
              }),
              {
                loading: 'Uploading the archive…',
                success: 'Archive uploaded',
                error: (error) =>
                  error instanceof Error ? `Upload failed: ${error.message}` : 'Upload failed'
              }
            )
          }
        }
      ]
    },
    {
      heading: 'Options',
      probes: [
        {
          label: 'With description',
          title: 'Show a notification with a description line',
          run: () =>
            toast.success('Project saved', { description: 'All files are written to disk.' })
        },
        {
          label: 'With action',
          title: 'Show a notification with an action button',
          run: () =>
            toast.success('Run finished', {
              action: { label: 'View', onClick: () => toast.info('View pressed') }
            })
        },
        {
          label: 'With cancel',
          title: 'Show a notification with a cancel button',
          run: () =>
            toast.info('Delete this branch?', {
              cancel: { label: 'Keep', onClick: () => toast.info('Kept the branch') }
            })
        },
        {
          label: 'Action and cancel',
          title: 'Show a notification with both an action and a cancel button',
          run: () =>
            toast.warning('Discard 3 changes?', {
              description: 'This cannot be undone.',
              action: { label: 'Discard', onClick: () => toast.info('Changes discarded') },
              cancel: { label: 'Cancel', onClick: () => toast.info('Changes kept') }
            })
        },
        {
          label: 'No close button',
          title: 'Show a notification without a close button',
          run: () => toast.success('No close button', { closeButton: false })
        },
        {
          label: 'Non-dismissible',
          title: 'Show a notification that resists a swipe',
          run: () => toast.info('This card resists a swipe', { dismissible: false })
        }
      ]
    }
  ]

  /** Clear the stack, so a new run of probes starts from an empty corner. */
  function dismissAll(): void {
    toast.dismiss()
  }
</script>

<div id="settings-block-about-toast-playground" class="mt-4 rounded-xl border bg-surface p-4">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">Notifications</h3>
      <p class="mt-1 text-xs leading-relaxed text-dimmed">
        Raise every notification state the app supports, to check how each one looks and behaves.
      </p>
    </div>
    <button
      type="button"
      class="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
      title="Dismiss every visible notification"
      onclick={dismissAll}
    >
      <Bell size={13} />
      Dismiss all
    </button>
  </div>

  {#each groups as group (group.heading)}
    <div class="mt-4">
      <p class="mb-2 text-[0.6875rem] font-medium uppercase tracking-wide text-dimmed">
        {group.heading}
      </p>
      <div class="flex flex-wrap gap-2">
        {#each group.probes as probe (probe.label)}
          <button
            type="button"
            class="flex h-9 items-center rounded-lg border bg-elevated px-3.5 text-xs font-medium hover:bg-overlay"
            title={probe.title}
            onclick={probe.run}
          >
            {probe.label}
          </button>
        {/each}
      </div>
    </div>
  {/each}
</div>
