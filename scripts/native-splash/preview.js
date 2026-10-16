import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeEmbeddedHeader } from './after-pack.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const directory = join(root, '.cio/tmp/native-splash-lockup')
if (process.platform !== 'darwin') throw new Error('This standalone native preview requires macOS.')
mkdirSync(directory, { recursive: true })
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
writeEmbeddedHeader(join(directory, 'embedded_icon.h'), version)
const executable = join(directory, 'CodeInOven')
const environment = {
  ...process.env,
  TMPDIR: join(root, '.cio/tmp/'),
  CLANG_MODULE_CACHE_PATH: join(directory, 'clang-cache')
}
const compile = spawnSync(
  '/usr/bin/clang',
  [
    '-fobjc-arc',
    '-Os',
    '-Wall',
    '-Wextra',
    '-I',
    directory,
    join(root, 'scripts/native-splash/native/launcher.m'),
    '-framework',
    'Cocoa',
    '-o',
    executable
  ],
  { cwd: root, env: environment, stdio: 'inherit' }
)
if (compile.error) throw compile.error
if (compile.status !== 0) process.exit(compile.status ?? 1)
process.stdout.write('Showing the current native splash for 15 seconds.\n')
const preview = spawnSync(executable, ['--codeinoven-native-splash-helper', '1'], {
  cwd: root,
  env: environment,
  stdio: ['ignore', 'ignore', 'inherit']
})
if (preview.error) throw preview.error
process.exit(preview.status ?? 1)
