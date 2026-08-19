/** Renderer runtime flags that keep Electron-only boot gates out of the phone PWA. */
let remotePwaRuntime = false

export function markRemotePwaRuntime(): void {
  remotePwaRuntime = true
}

export function isRemotePwaRuntime(): boolean {
  return remotePwaRuntime
}
