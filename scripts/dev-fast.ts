/**
 * Run the app from the production bundle, for a boot that costs what a shipped
 * launch costs.
 *
 * `bun run dev` serves the renderer as unbundled modules: Vite compiles every
 * Svelte and TypeScript module the moment the renderer asks for it, so a cold
 * launch transforms roughly 250 of them before the app can mount, and the
 * conversation the launch restores waits behind that work. Measured on one data
 * root, same machine, same build of the app:
 *
 *   bun run dev            conversation on screen at ~10.5 s (cold)
 *   production bundle      conversation on screen at ~1.3 s
 *
 * Nothing about the app differs between those two numbers: the packaged run
 * loads 75 prebuilt chunks instead of compiling 250 modules in the browser
 * process, which is the whole gap. This runner builds that same bundle once and
 * launches Electron straight at it, so a dev launch boots exactly like the
 * shipped app while HMR is not needed.
 *
 *   bun run dev:fast                             live data root
 *   CODEINOVEN_CONFIG_ROOT=/abs/root bun run dev:fast
 *   bun run dev:fast -- --remote-debugging-port=9222
 *
 * It builds once. Code changes need another run (or `bun run dev:fast` again);
 * use `bun run dev` when HMR matters more than the boot time.
 */
import { spawn } from 'node:child_process'
import electronBinary from 'electron'

const PROJECT_ROOT = new URL('..', import.meta.url).pathname
const EXTRA_ARGUMENTS = process.argv.slice(2)

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: PROJECT_ROOT, stdio: 'inherit' })
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

// The same build the release ships, so the boot this runner measures is the
// boot the packaged app has. A development-mode bundle was tried and does not
// boot: its main process waits for the dev server that this runner never starts.
const buildCode = await run('bunx', ['electron-vite', 'build'])
if (buildCode !== 0) {
  process.stderr.write('dev:fast: the bundle did not build, so there is nothing to launch.\n')
  process.exit(buildCode)
}

const app = spawn(electronBinary as unknown as string, ['.', ...EXTRA_ARGUMENTS], {
  cwd: PROJECT_ROOT,
  stdio: 'inherit'
})
app.on('exit', (code) => process.exit(code ?? 0))

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => app.kill(signal))
}
