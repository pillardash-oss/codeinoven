import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

const projectRoot = process.cwd()
const requestedPaths = Bun.argv.slice(2)
const supportedExtensions = new Set(['.svelte', '.ts'])

interface CheckScope {
  files: string[]
  workspace: string
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
      files: [absolutePath],
      workspace: dirname(absolutePath)
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
    files,
    workspace: absolutePath
  }
}

async function runSvelteCheck(tsconfigPath: string, workspace = projectRoot): Promise<number> {
  const child = Bun.spawn(
    [
      process.execPath,
      'node_modules/svelte-check/bin/svelte-check',
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
  process.exit(await runSvelteCheck(join(projectRoot, 'tsconfig.json')))
}

const scopes = await Promise.all(requestedPaths.map(createCheckScope))
const checkedFiles = [...new Set(scopes.flatMap((scope) => scope.files))].sort()

if (checkedFiles.length === 0) {
  fail('No .ts or .svelte files were found in the requested paths.')
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'codeinoven-check-'))

try {
  let exitCode = 0

  for (const [index, scope] of scopes.entries()) {
    const scopedTsconfigPath = join(temporaryDirectory, `tsconfig-${index}.json`)
    await Bun.write(
      scopedTsconfigPath,
      `${JSON.stringify(
        {
          compilerOptions: {
            typeRoots: [join(projectRoot, 'node_modules/@types')]
          },
          extends: join(projectRoot, 'tsconfig.json'),
          exclude: [],
          files: scope.files,
          include: []
        },
        null,
        2
      )}\n`
    )
    exitCode ||= await runSvelteCheck(scopedTsconfigPath, scope.workspace)
  }

  process.exitCode = exitCode
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true })
}
