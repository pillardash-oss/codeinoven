import type { CustomPublishOptions } from 'builder-util-runtime'
import type { OutgoingHttpHeaders } from 'node:http'
import type { AppUpdater } from 'electron-updater'
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider.js'
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider.js'
import { Logger } from '../system/logger'
import { selectNightlyChannelRelease } from './updater-install-recovery'

/**
 * Nightly is an opt-in to prereleases that also cross over to the stable
 * release its cycle is promoted to, but never back to the stable build of the
 * very same base: `0.5.66` next to a running or offered `0.5.66-nightly.5` is
 * the code the install already has. See `selectNightlyChannelRelease`.
 */
export class UpdaterReleaseProvider extends GitHubProvider {
  private readonly stableProvider: GitHubProvider

  constructor(
    _options: CustomPublishOptions,
    private readonly releaseUpdater: AppUpdater,
    runtimeOptions: ProviderRuntimeOptions
  ) {
    const github = { provider: 'github', owner: 'pillardash-oss', repo: 'codeinoven' } as const
    super(github, releaseUpdater, runtimeOptions)
    // Give the stable lookup its own channel view without mutating the updater
    // while the two requests are in flight. All other runtime state stays shared.
    const stableUpdater = new Proxy(releaseUpdater, {
      get(target, property) {
        if (property === 'channel') return 'latest'
        if (property === 'allowPrerelease') return false
        return Reflect.get(target, property, target)
      }
    })
    this.stableProvider = new GitHubProvider(github, stableUpdater, runtimeOptions)
  }

  override setRequestHeaders(headers: OutgoingHttpHeaders | null): void {
    super.setRequestHeaders(headers)
    this.stableProvider.setRequestHeaders(headers)
  }

  override async getLatestVersion() {
    if (!this.releaseUpdater.allowPrerelease || this.releaseUpdater.channel !== 'nightly') {
      return super.getLatestVersion()
    }

    const [nightly, stable] = await Promise.allSettled([
      super.getLatestVersion(),
      this.stableProvider.getLatestVersion()
    ])
    // Either channel may be temporarily unavailable, or have no release yet.
    // Keep the healthy channel usable without allowing a downgrade.
    if (nightly.status === 'rejected') {
      if (stable.status === 'fulfilled') {
        Logger.dev('Updater: nightly lookup failed; using the stable feed')
        return stable.value
      }
      throw new AggregateError(
        [nightly.reason, stable.reason],
        'Could not read either update channel'
      )
    }
    if (stable.status === 'rejected') {
      Logger.dev('Updater: stable lookup failed; using the nightly feed')
      return nightly.value
    }
    return selectNightlyChannelRelease(nightly.value, stable.value)
  }
}
