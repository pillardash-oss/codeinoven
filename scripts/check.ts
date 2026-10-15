import { mkdir, open, rm, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'

const projectRoot = process.cwd()
const requestedPaths = Bun.argv.slice(2)
const supportedExtensions = new Set(['.svelte', '.ts'])

// A scoped tsconfig has to sit exactly two levels below the project root. svelte-check
// rewrites its specs for the overlay tsconfig it writes into `.svelte-check` by
// prefixing each one with `svelte/`, and only at this depth does that prefix resolve
// back to the shim (or the real source, for a `.ts` file) it was derived from.
// `.cio/tmp/` is exactly that depth, and it is the project's disposable scratch space.
const scratchDirectory = join(projectRoot, '.cio', 'tmp')

// The cached runs share svelte-check's svelte2tsx emit cache in `.svelte-check/` at the
// project root (there is no `.svelte-kit` here). It is gitignored and, unlike the shims
// it used to be thrown away for, it is reusable: the cache manifest prunes the shims of
// sources that have since been deleted, so a warm cache stays accurate. Only one run may
// own it at a time, because two concurrent runs rewriting the same shims and manifest can
// hand each other half-written files. A run that cannot take it falls back to an uncached
// check instead of failing.
const cacheLockPath = join(scratchDirectory, 'svelte-check.lock')
const cacheLockPollMs = 250
const cacheLockWaitMs = 60_000
const cacheLockStaleMs = 15 * 60 * 1000

interface CheckScope {
  files: string[]
}

interface SvelteCheckRun {
  /** Type-check through the native tsgo compiler with the emit cache enabled. */
  useCache: boolean
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

async function createCheckScope(inputPath: string): Promise<CheckScope> {
  const absolutePath = resolve(projectRoot, inputPath)
  const projectRelativePath = relative(projectRoot, absolutePath)

  if (projectRelativePath.startsWith('..') || isAbsolute(projectRelativePath)) {
    fail(`Cannot check a path outside the project: ${inputPath}`)
  }

  let pathStats
  try {
    pathStats = await stat(absolutePath)
  } catch {
    fail(`Cannot check a path that does not exist: ${inputPath}`)
  }

  if (pathStats.isFile()) {
    if (!supportedExtensions.has(extname(absolutePath))) {
      fail(`Unsupported check file type: ${inputPath}. Expected a .ts or .svelte file.`)
    }
    return {
      files: [absolutePath]
    }
  }

  if (!pathStats.isDirectory()) {
    fail(`Cannot check a non-file path: ${inputPath}`)
  }

  const glob = new Bun.Glob('**/*.{svelte,ts}')
  const files: string[] = []
  for await (const file of glob.scan({ absolute: true, cwd: absolutePath, onlyFiles: true })) {
    files.push(file)
  }
  return {
    files
  }
}

async function writeScopeTsconfig(tsconfigPath: string, files: string[]): Promise<void> {
  await Bun.write(
    tsconfigPath,
    `${JSON.stringify(
      {
        compilerOptions: {
          typeRoots: [join(projectRoot, 'node_modules/@types')],
          types: ['bun', 'node']
        },
        extends: join(projectRoot, 'tsconfig.json'),
        exclude: [],
        files: files.map((file) => relative(scratchDirectory, file)),
        include: [join(projectRoot, 'src/main/types/**/*.ts')]
      },
      null,
      2
    )}\n`
  )
}

async function runSvelteCheck(tsconfigPath: string, run: SvelteCheckRun): Promise<number> {
  const child = Bun.spawn(
    [
      process.execPath,
      'node_modules/svelte-check/bin/svelte-check',
      ...(run.useCache ? ['--tsgo', '--incremental'] : []),
      '--workspace',
      projectRoot,
      '--config',
      join(projectRoot, 'svelte.config.js'),
      '--tsconfig',
      tsconfigPath
    ],
    {
      cwd: projectRoot,
      stderr: 'inherit',
      stdin: 'inherit',
      stdout: 'inherit'
    }
  )

  return child.exited
}

async function readLockAgeMs(): Promise<number | undefined> {
  try {
    const lockStats = await stat(cacheLockPath)
    return Date.now() - lockStats.mtimeMs
  } catch {
    return undefined
  }
}

/**
 * Takes the emit cache for this run. Returns false when another check holds it, in
 * which case the caller runs without the cache instead of waiting forever. A lock left
 * behind by a killed run is stolen once it is older than {@link cacheLockStaleMs}.
 */
async function acquireCacheLock(): Promise<boolean> {
  await mkdir(scratchDirectory, { recursive: true })
  const deadline = Date.now() + cacheLockWaitMs

  for (;;) {
    try {
      const handle = await open(cacheLockPath, 'wx')
      await handle.writeFile(`${process.pid}\n`)
      await handle.close()
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        process.stderr.write(
          `Cannot take the svelte-check cache lock at ${relative(projectRoot, cacheLockPath)}: ${
            error instanceof Error ? error.message : String(error)
          }. Checking without the cache.\n`
        )
        return false
      }
    }

    const lockAgeMs = await readLockAgeMs()
    if (lockAgeMs !== undefined && lockAgeMs > cacheLockStaleMs) {
      await rm(cacheLockPath, { force: true })
      continue
    }

    if (Date.now() >= deadline) {
      process.stderr.write(
        'Another check is using the svelte-check cache. Checking without the cache, which is slower.\n'
      )
      return false
    }

    await Bun.sleep(cacheLockPollMs)
  }
}

async function releaseCacheLock(): Promise<void> {
  await rm(cacheLockPath, { force: true })
}

async function runWithCacheLock(run: () => Promise<number>): Promise<number> {
  const hasLock = await acquireCacheLock()
  try {
    return await run()
  } finally {
    if (hasLock) {
      await releaseCacheLock()
    }
  }
}

if (requestedPaths.length === 0) {
  // The whole project goes through the tsgo compiler with the emit cache on, so a
  // second run re-transpiles only the components that changed. This is the same path
  // a scoped `.ts` run takes; neither of them can see Svelte compiler diagnostics
  // inside a component that fails to transpile, so use `bun run check <paths>` for
  // components you changed.
  process.exit(
    await runWithCacheLock(() =>
      runSvelteCheck(join(projectRoot, 'tsconfig.json'), { useCache: true })
    )
  )
}

const scopes = await Promise.all(requestedPaths.map(createCheckScope))
const checkedFiles = [...new Set(scopes.flatMap((scope) => scope.files))].sort()

if (checkedFiles.length === 0) {
  fail('No .ts or .svelte files were found in the requested paths.')
}

// One requested set is one svelte-check process, and the kind of set decides the path.
// A set that contains a Svelte component has to run through the in-process language
// service: it is the only path that reports Svelte compiler diagnostics, and the cached
// path drops every diagnostic in a component whose transpile fails, which is exactly the
// component an agent is most likely to leave behind. A set that is TypeScript only needs
// none of that, so it type-checks through the native tsgo compiler with the emit cache on.
const runsSvelteDiagnostics = checkedFiles.some((file) => extname(file) === '.svelte')
const batch = { files: checkedFiles, run: { useCache: !runsSvelteDiagnostics } }

// A scoped tsconfig references project files with paths relative to the folder that
// holds it, and the cache directory is shared, so the temporary configs are staged
// directly inside `.cio/tmp/` and removed afterwards either way. The repo root and the
// `.cio/` root stay clean, and an interrupted run leaves nothing but a stale file there.
await mkdir(scratchDirectory, { recursive: true })
const scratchId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const scopedTsconfigPath = join(scratchDirectory, `check-${scratchId}.json`)

try {
  await writeScopeTsconfig(scopedTsconfigPath, batch.files)

  // The exit code is assigned directly. The older per-path loop folded it in with
  // `exitCode ||= await ...`, which short-circuits and silently skipped every path after
  // the first failing one.
  process.exitCode = batch.run.useCache
    ? await runWithCacheLock(() => runSvelteCheck(scopedTsconfigPath, batch.run))
    : await runSvelteCheck(scopedTsconfigPath, batch.run)
} finally {
  await rm(scopedTsconfigPath, { force: true })
}
