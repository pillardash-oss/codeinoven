<script lang="ts">
  import CioSpinner from '$lib/components/icons/cio/CioSpinner.svelte'
  import type { ProviderSignInController } from './provider-sign-in.svelte'

  /**
   * The live half of an in-app sign-in: the progress line, the device code, and
   * whatever the provider's flow is waiting on. Every surface that starts a Pi
   * sign-in renders this, so the flow looks and behaves the same whether it was
   * launched from the add-provider panel or from a provider error card.
   */
  interface Props {
    oauth: ProviderSignInController
  }

  let { oauth }: Props = $props()
</script>

<div class="space-y-2">
  <div class="flex items-center gap-2">
    <CioSpinner size={13} class="animate-spin text-primary" />
    <p class="min-w-0 flex-1 truncate text-[0.6875rem] text-muted" aria-live="polite">
      {oauth.status || 'Waiting for the provider…'}
    </p>
    <button
      class="shrink-0 border bg-elevated px-2 py-1 text-[0.625rem] font-medium text-muted hover:bg-overlay"
      type="button"
      title="Cancel the sign-in"
      onclick={() => void oauth.cancel()}
    >
      Cancel
    </button>
  </div>
  {#if oauth.deviceCode}
    <div class="border bg-surface p-2.5 text-center">
      <p class="text-[0.625rem] text-dimmed">
        Enter this code at
        <button
          class="font-medium text-primary underline underline-offset-2"
          type="button"
          title="Open {oauth.deviceCode.verificationUri}"
          data-external-url={oauth.deviceCode.verificationUri}
          onclick={() => void oauth.openDeviceCodePage()}
        >
          {oauth.deviceCode.verificationUri}
        </button>
      </p>
      <p class="mt-1 font-mono text-base font-semibold tracking-widest text-foreground">
        {oauth.deviceCode.userCode}
      </p>
    </div>
  {/if}
  {#if oauth.prompt}
    <div class="space-y-1.5">
      {#if oauth.prompt.type === 'select' && oauth.prompt.options}
        <p class="text-[0.6875rem] font-medium text-foreground">
          {oauth.prompt.message}
        </p>
        <div class="space-y-1">
          {#each oauth.prompt.options as option (option.id)}
            <button
              class="w-full border bg-elevated px-3 py-2 text-left text-xs text-foreground hover:bg-overlay"
              type="button"
              title="Choose {option.label}"
              onclick={() => void oauth.answerSelect(option.id)}
            >
              {option.label}
            </button>
          {/each}
        </div>
      {:else}
        <label class="block text-[0.6875rem] font-medium text-foreground" for="oauth-prompt-input">
          {oauth.prompt.message}
        </label>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          id="oauth-prompt-input"
          type={oauth.prompt.type === 'secret' ? 'password' : 'text'}
          autocomplete="off"
          spellcheck="false"
          class="h-9 w-full border bg-elevated px-3 text-sm outline-none focus:border-primary"
          placeholder={oauth.prompt.placeholder ??
            (oauth.prompt.type === 'secret' ? 'Enter the value' : 'Paste the code')}
          bind:value={oauth.promptAnswer}
          autofocus
          onkeydown={(event: KeyboardEvent) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void oauth.submitPrompt()
            }
          }}
        />
        <button
          class="flex h-8 w-full items-center justify-center bg-primary text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          type="button"
          title="Continue the sign-in"
          disabled={oauth.promptAnswer.trim() === ''}
          onclick={() => void oauth.submitPrompt()}
        >
          Continue
        </button>
      {/if}
    </div>
  {/if}
</div>
