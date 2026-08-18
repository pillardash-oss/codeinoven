<script lang="ts">
  import { Dialog } from 'bits-ui'
  import { ScanLine, X } from '@lucide/svelte'
  import type QrScanner from 'qr-scanner'

  interface Props {
    onScan: (value: string) => boolean
    onClose: () => void
  }

  let { onScan, onClose }: Props = $props()

  let scanner: QrScanner | null = null
  let scannerError = $state('')
  let starting = $state(true)
  let accepted = false

  function stopScanner(): void {
    scanner?.destroy()
    scanner = null
  }

  function closeScanner(): void {
    stopScanner()
    onClose()
  }

  function cameraErrorMessage(error: unknown): string {
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      return 'Camera access was denied. Allow camera access in your browser settings and try again.'
    }
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      return 'No camera was found on this device.'
    }
    return 'The camera could not be opened. You can still enter the pairing code manually.'
  }

  async function startScanner(
    videoElement: HTMLVideoElement,
    detached: () => boolean
  ): Promise<void> {
    try {
      const { default: QrScannerConstructor } = await import('qr-scanner')
      if (detached()) return
      scanner = new QrScannerConstructor(
        videoElement,
        (result) => {
          if (accepted) return
          if (!onScan(result.data)) {
            scannerError =
              'That is not a CodeInOven pairing QR. Scan the second QR on your desktop.'
            return
          }
          accepted = true
          closeScanner()
        },
        {
          preferredCamera: 'environment',
          maxScansPerSecond: 8,
          highlightScanRegion: true,
          highlightCodeOutline: true,
          returnDetailedScanResult: true
        }
      )
      await scanner.start()
      if (detached()) stopScanner()
    } catch (error) {
      if (!detached()) {
        stopScanner()
        scannerError = cameraErrorMessage(error)
      }
    } finally {
      if (!detached()) starting = false
    }
  }

  function attachScanner(videoElement: HTMLVideoElement): () => void {
    let detached = false
    void startScanner(videoElement, () => detached)
    return () => {
      detached = true
      stopScanner()
    }
  }
</script>

<Dialog.Root
  open
  onOpenChange={(open) => {
    if (!open) closeScanner()
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-overlay/80" />
    <Dialog.Content
      class="fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-2xl border-t border-border bg-app pb-[env(safe-area-inset-bottom)] shadow-2xl sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:w-[min(28rem,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border"
    >
      <header class="flex shrink-0 items-start justify-between gap-3 border-b border-border p-4">
        <div>
          <Dialog.Title class="flex items-center gap-2 text-sm font-semibold text-foreground">
            <ScanLine size={16} /> Scan pairing QR
          </Dialog.Title>
          <Dialog.Description class="mt-1 text-xs leading-relaxed text-muted">
            Point your camera at the second QR shown in Remote settings on your desktop.
          </Dialog.Description>
        </div>
        <Dialog.Close
          class="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted hover:bg-elevated hover:text-foreground"
          title="Close QR scanner"
          aria-label="Close QR scanner"
        >
          <X size={17} />
        </Dialog.Close>
      </header>

      <div class="min-h-0 overflow-y-auto p-4">
        <div class="relative aspect-square overflow-hidden rounded-xl bg-raised">
          <video
            {@attach attachScanner}
            class="h-full w-full object-cover"
            aria-label="Live camera preview for pairing QR code"
            playsinline
            muted
          ></video>
          {#if starting}
            <div class="absolute inset-0 grid place-items-center bg-raised text-xs text-muted">
              Opening camera…
            </div>
          {/if}
        </div>

        {#if scannerError}
          <p class="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
            {scannerError}
          </p>
        {:else}
          <p class="mt-3 text-center text-xs text-muted" aria-live="polite">
            Hold the QR inside the square. Pairing continues automatically when it is recognized.
          </p>
        {/if}
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
