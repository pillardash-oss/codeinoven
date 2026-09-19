<script lang="ts">
  import type { SyncedDeviceUsage } from '$shared/types'
  import {
    formatCost,
    formatDateTime,
    formatDuration,
    formatNumber,
    platformLabel
  } from './profile-settings-format'

  interface Props {
    devices: SyncedDeviceUsage[]
  }

  let { devices }: Props = $props()
</script>

<section class="mt-4 rounded-xl border" aria-labelledby="devices-heading">
  <div class="border-b px-4 py-3">
    <h2 id="devices-heading" class="text-sm font-semibold">Devices</h2>
    <p class="mt-0.5 text-xs text-muted">
      Synced usage from every device signed in to this account.
    </p>
  </div>
  {#if devices.length > 0}
    <div class="grid gap-4 p-4 lg:grid-cols-2">
      {#each devices as device (device.deviceId)}
        <article class="rounded-xl border p-4">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="truncate text-sm font-semibold">{device.deviceLabel}</p>
              <p class="mt-0.5 text-[0.6875rem] text-dimmed">
                {platformLabel(device.platform)} · last synced {formatDateTime(device.updatedAt)}
              </p>
            </div>
            <span
              class="shrink-0 rounded-md bg-raised px-2 py-1 text-[0.625rem] font-medium tabular-nums text-muted"
              title="Total agent runtime"
            >
              {formatDuration(device.durationMs)}
            </span>
          </div>
          <dl class="mt-4 grid grid-cols-4 gap-2 text-xs">
            <div>
              <dt class="text-dimmed">Sessions</dt>
              <dd class="mt-0.5 font-semibold tabular-nums">
                {formatNumber(device.messageCount)}
              </dd>
            </div>
            <div>
              <dt class="text-dimmed">Tokens</dt>
              <dd class="mt-0.5 font-semibold tabular-nums">{formatNumber(device.tokens)}</dd>
            </div>
            <div>
              <dt class="text-dimmed">Cost</dt>
              <dd class="mt-0.5 font-semibold tabular-nums">{formatCost(device.costUsd)}</dd>
            </div>
            <div>
              <dt class="text-dimmed">Active days</dt>
              <dd class="mt-0.5 font-semibold tabular-nums">{device.activeDays}</dd>
            </div>
          </dl>
          {#if device.projects.length > 0}
            <div class="mt-4 border-t pt-3">
              <p class="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted">
                Top projects
              </p>
              <ul class="mt-2 space-y-1.5">
                {#each device.projects.slice(0, 4) as project (project.id)}
                  <li class="flex items-center justify-between gap-3 text-xs">
                    <span class="min-w-0 truncate font-medium">{project.name}</span>
                    <span class="shrink-0 tabular-nums text-muted">
                      {formatNumber(project.messageCount)} sessions · {formatDuration(
                        project.durationMs
                      )}
                    </span>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        </article>
      {/each}
    </div>
  {:else}
    <p class="px-4 py-8 text-center text-xs text-muted">
      No device usage has been synced yet. It appears after your first signed-in agent session.
    </p>
  {/if}
</section>
