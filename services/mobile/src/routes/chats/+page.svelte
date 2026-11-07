<script lang="ts">
  import CioChat from '@pdslng/cio-icon/CioChat.svelte'
  import PanelBar from '#lib/components/PanelBar.svelte'
</script>

<PanelBar title="Chats" />

<div class="list">
  <div class="chats-empty">
    <span class="plate"><CioChat size={20} /></span>
    <p class="chats-title">Your chats live on the desktop</p>
    <p class="chats-line">
      This service mirrors projects, threads and assistants. A chat belongs to no project and no
      thread, so this client has nothing to list here yet, and an empty screen is better than a tab
      that pretends.
    </p>
  </div>
</div>

<style>
  .chats-empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 2.5rem var(--gutter);
  }

  .plate {
    display: grid;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    margin-bottom: 0.25rem;
    background: var(--color-elevated);
    color: var(--color-muted);
  }

  .chats-title {
    margin: 0;
    font-size: 1rem;
  }

  .chats-line {
    margin: 0;
    max-width: 32ch;
    font-size: 0.8125rem;
    line-height: 1.5;
    color: var(--color-muted);
  }
</style>
