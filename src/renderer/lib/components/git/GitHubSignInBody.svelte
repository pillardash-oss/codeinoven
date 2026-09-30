<script lang="ts">
  import { Check, Copy, Loader2, TimerOff } from '@lucide/svelte'
  import { githubSignIn } from '$lib/stores/github-sign-in.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'

  /**
   * The sign-in flow itself: where the attempt stands, the code GitHub issued and
   * the countdown on it.
   *
   * One component because two surfaces present it: the floating panel
   * (`GitHubSignInDock`), which serves every view but the browser's own, and the
   * browser's docked bar (`GitHubSignInBrowserDock`), which serves the page the
   * code has to be typed into. Only the shells differ, so the flow is written
   * once, and neither shell can drift from the other.
   *
   * It draws no padding or scroll of its own: the host owns the frame, because
   * the two hosts frame it differently.
   */
</script>

{#if githubSignIn.phase === 'starting'}
  <div class="flex items-center justify-center gap-2 py-10 text-xs text-dimmed">
    <Loader2 size={14} class="animate-spin" aria-hidden="true" />
    Starting sign-in…
  </div>
{:else if githubSignIn.phase === 'waiting' && githubSignIn.device}
  <div class="space-y-4">
    <p class="flex items-start gap-2 text-xs leading-relaxed text-muted">
      <VendorIcon name="GitHub" size={14} class="mt-0.5 shrink-0 text-foreground" />
      Enter this code on GitHub to connect your account.
    </p>

    <button
      type="button"
      class="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-border bg-elevated px-4 py-3 transition-colors hover:border-muted"
      title="Copy the code"
      aria-label="Copy the device code"
      onclick={() => void githubSignIn.copyCode()}
    >
      <span class="select-all font-mono text-3xl font-semibold tracking-[0.2em] text-foreground">
        {githubSignIn.device.userCode}
      </span>
      {#if githubSignIn.copied}
        <Check size={16} class="text-success" />
      {:else}
        <Copy size={16} class="text-dimmed" />
      {/if}
    </button>

    {#if githubSignIn.copyError}
      <p role="alert" class="text-center text-[0.625rem] text-danger">{githubSignIn.copyError}</p>
    {/if}

    <p class="text-center text-[0.625rem] leading-relaxed text-dimmed">
      Signing in inside CodeInOven copies the code and docks this panel under the page, so it stays
      readable while you authorize.
    </p>

    <p
      class="flex items-center justify-center gap-1.5 text-[0.625rem] text-dimmed"
      aria-live="polite"
    >
      <Loader2 size={11} class="animate-spin" />
      {#if githubSignIn.remaining > 0}
        Waiting for you to authorize… code expires in {githubSignIn.countdown}
      {:else}
        Waiting for you to authorize…
      {/if}
    </p>
  </div>
{:else if githubSignIn.phase === 'authorized'}
  <div class="flex flex-col items-center justify-center py-8 text-center">
    <div class="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-success/10">
      <Check size={18} class="text-success" />
    </div>
    <p class="text-xs font-medium text-foreground">Signed in to GitHub</p>
    <p class="mt-1 text-[0.625rem] text-dimmed">
      Pull requests and sync now use your GitHub account.
    </p>
  </div>
{:else if githubSignIn.phase === 'expired'}
  <div class="flex flex-col items-center justify-center py-8 text-center">
    <div class="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-warning/10">
      <TimerOff size={18} class="text-warning" />
    </div>
    <p class="text-xs font-medium text-foreground">Code expired</p>
    <p class="mt-1 max-w-[30ch] text-[0.625rem] leading-relaxed text-dimmed">
      The sign-in code expired before it was authorized. Try again with a fresh code.
    </p>
  </div>
{:else}
  <div class="flex flex-col items-center justify-center py-8 text-center">
    <p class="text-xs font-medium text-danger">Sign-in failed</p>
    {#if githubSignIn.message}
      <p class="mt-1 max-w-[34ch] text-[0.625rem] leading-relaxed text-dimmed">
        {githubSignIn.message}
      </p>
    {/if}
  </div>
{/if}
