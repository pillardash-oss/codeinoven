import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

// Build-time convenience only. Distributed binaries require neither Bun nor Go.
const root = resolve(import.meta.dir, '../..')
const scratch = resolve(root, '.cio/tmp/harness-benchmark')
const output = resolve(root, '.cio/work/harness-benchmark/bin')
const targets = [
  ['darwin', 'arm64'],
  ['linux', '386'],
  ['linux', 'amd64'],
  ['linux', 'arm'],
  ['linux', 'arm64'],
  ['windows', '386'],
  ['windows', 'amd64'],
  ['windows', 'arm64']
] as const
for (const directory of [output, `${scratch}/go-cache`, `${scratch}/go-mod`, `${scratch}/go-tmp`]) {
  await mkdir(directory, { recursive: true })
}
const failures: string[] = []
let next = 0
async function worker(): Promise<void> {
  while (next < targets.length) {
    const [os, arch] = targets[next++]
    const name = `harness-benchmark-${os}-${arch}${os === 'windows' ? '.exe' : ''}`
    const child = Bun.spawn(
      [
        'go',
        'build',
        '-mod=readonly',
        '-buildvcs=false',
        '-trimpath',
        '-p=2',
        '-ldflags=-s -w',
        '-o',
        resolve(output, name),
        '.'
      ],
      {
        cwd: import.meta.dir,
        env: {
          ...process.env,
          GOOS: os,
          GOARCH: arch,
          GOARM: '7',
          CGO_ENABLED: '0',
          GOMAXPROCS: '2',
          GOTOOLCHAIN: 'local',
          GOCACHE: `${scratch}/go-cache`,
          GOMODCACHE: `${scratch}/go-mod`,
          GOTMPDIR: `${scratch}/go-tmp`
        },
        stdout: 'ignore',
        stderr: 'pipe'
      }
    )
    const detail = await new Response(child.stderr).text()
    const status = await child.exited
    process.stdout.write(`${name}: ${status === 0 ? 'built' : 'FAILED'}\n`)
    if (status !== 0) failures.push(`${name}\n${detail}`)
  }
}
await Promise.all([worker(), worker()])
if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`Binaries: ${output}\n`)
}
