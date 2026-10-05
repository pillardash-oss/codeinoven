import { stripVTControlCharacters } from 'node:util'
import type { OvenSetupStep } from '../../lib/ovens'

type InstallProgress = NonNullable<OvenSetupStep['installProgress']>

/** Consume bounded installer records; only fixed labels and measured numbers escape. */
export class OvenInstallProgress {
  private pending = ''
  private stage: InstallProgress['stage'] = 'installing'

  consume(chunk: string): InstallProgress | undefined {
    const records = stripVTControlCharacters(this.pending + chunk).split(/[\r\n]/u)
    this.pending = (records.pop() ?? '').slice(-2048)
    let latest: InstallProgress | undefined
    for (const record of records) {
      const line = record.slice(-2048)
      const transfer = line.match(
        /(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|KiB|MiB|GiB)\s*\/\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|KiB|MiB|GiB)(?:\s|$)/iu
      )
      if (transfer) {
        const units: Record<string, number> = {
          b: 1,
          kb: 1e3,
          mb: 1e6,
          gb: 1e9,
          kib: 1024,
          mib: 1024 ** 2,
          gib: 1024 ** 3
        }
        const received = Number(transfer[1]) * units[transfer[2].toLowerCase()]
        const total = Number(transfer[3]) * units[transfer[4].toLowerCase()]
        if (
          Number.isFinite(total) &&
          Number.isFinite(received) &&
          total > 0 &&
          received >= 0 &&
          received <= total
        ) {
          this.stage = 'downloading'
          latest = { stage: this.stage, percent: Math.round((received / total) * 100) }
        }
        continue
      }
      if (/downloading|npm http fetch|fetching|retrieving/iu.test(line)) this.stage = 'downloading'
      else if (/installing|extracting|unpacking|npm info run|linking/iu.test(line))
        this.stage = 'installing'
      else if (!/^[#=> .\d%+-]+$/u.test(line.trim()) || !/%/u.test(line)) continue
      const percentage = line.match(/(?:^|\s)(\d{1,3}(?:\.\d+)?)\s*%(?:\s|$)/u)
      const value = percentage ? Number(percentage[1]) : undefined
      const percent =
        value !== undefined && value >= 0 && value <= 100 ? Math.round(value) : undefined
      if (
        percent === undefined &&
        !/downloading|npm http fetch|fetching|retrieving|installing|extracting|unpacking|npm info run|linking/iu.test(
          line
        )
      )
        continue
      latest = { stage: this.stage, ...(percent !== undefined ? { percent } : {}) }
    }
    return latest
  }
}
