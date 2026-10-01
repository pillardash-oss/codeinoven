import { mkdir, rm, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'

const projectRoot = process.cwd()
const requestedPaths = Bun.argv.slice(2)
const supportedExtensions = new Set(['.svelte', '.ts'])

interface CheckScope {
  files: string[]
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

async function runSvelteCheck(
  tsconfigPath: string,
  workspace = projectRoot,
  useTsgo = true
): Promise<number> {
  const child = Bun.spawn(
    [
      process.execPath,
      'node_modules/svelte-check/bin/svelte-check',
      ...(useTsgo ? ['--tsgo'] : []),
      '--workspace',
      workspace,
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

if (requestedPaths.length === 0) {
  // svelte-check writes generated `.svelte.ts` shims into `.svelte-check` and
  // leaves them behind. Those shims are picked up by the next run, so a shim
  // left over from a source file that has since been deleted is still
  // type-checked and reports errors for code that no longer exists. Start from
  // a clean directory, exactly as the path-scoped runs below do.
  await rm(join(projectRoot, '.svelte-check'), { force: true, recursive: true })
  process.exit(await runSvelteCheck(join(projectRoot, 'tsconfig.json')))
}

const scopes = await Promise.all(requestedPaths.map(createCheckScope))
const checkedFiles = [...new Set(scopes.flatMap((scope) => scope.files))].sort()

if (checkedFiles.length === 0) {
  fail('No .ts or .svelte files were found in the requested paths.')
}

// A scoped tsconfig references project files with paths relative to the folder
// that holds it. svelte-check rewrites those specs for the overlay tsconfig it
// writes into `.svelte-check` by prefixing each one with `svelte/`, and that
// only resolves when the folder holding the temporary tsconfig sits exactly two
// levels below the project root. `.cio/tmp/` is exactly that depth, so the
// temporary tsconfigs are staged directly inside it. The repo root and the
// `.cio/` root stay clean, and `.cio/tmp/` is the project's disposable scratch
// space, so an interrupted run leaves nothing but a stale file there.
const scratchDirectory = join(projectRoot, '.cio', 'tmp')
await mkdir(scratchDirectory, { recursive: true })
const scratchId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const scopedTsconfigPaths: string[] = []

try {
  let exitCode = 0

  for (const [index, scope] of scopes.entries()) {
    const scopedTsconfigPath = join(scratchDirectory, `check-${scratchId}-${index}.json`)
    scopedTsconfigPaths.push(scopedTsconfigPath)
    await Bun.write(
      scopedTsconfigPath,
      `${JSON.stringify(
        {
          compilerOptions: {
            typeRoots: [join(projectRoot, 'node_modules/@types')],
            types: ['bun', 'node']
          },
          extends: join(projectRoot, 'tsconfig.json'),
          exclude: [],
          files: scope.files.map((file) => relative(scratchDirectory, file)),
          include: [join(projectRoot, 'src/main/types/**/*.ts')]
        },
        null,
        2
      )}\n`
    )
    const containsSvelte = scope.files.some((file) => extname(file) === '.svelte')
    exitCode ||= await runSvelteCheck(scopedTsconfigPath, projectRoot, !containsSvelte)
  }

  process.exitCode = exitCode
} finally {
  await Promise.all(
    scopedTsconfigPaths.map((scopedTsconfigPath) => rm(scopedTsconfigPath, { force: true }))
  )
  await rm(join(projectRoot, '.svelte-check'), { force: true, recursive: true })
}
