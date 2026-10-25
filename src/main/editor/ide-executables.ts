import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { IDE_SERVER_PACKAGES } from '../../lib/ide-language-servers'

/** Bounded discovery only. Never run Neovim or load its configuration. */
export async function resolveIdeExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd?: string
): Promise<string | undefined> {
  const explicit = command.includes('/') || command.includes('\\')
  const candidates: string[] = []
  if (explicit) candidates.push(isAbsolute(command) ? command : resolve(cwd ?? '.', command))
  else {
    if (IDE_SERVER_PACKAGES[command] && env.CODEINOVEN_IDE_BIN)
      candidates.push(join(env.CODEINOVEN_IDE_BIN, command))
    for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean))
      candidates.push(join(directory, command))
    const home = env.HOME || env.USERPROFILE || homedir()
    const appName = env.NVIM_APPNAME || 'nvim'
    // Restrict the app name to a directory name, never a traversal path.
    if (/^[a-zA-Z0-9_.-]+$/u.test(appName) && appName !== '.' && appName !== '..') {
      const dataRoots = new Set([
        join(env.XDG_DATA_HOME || join(home, '.local', 'share'), appName),
        ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, `${appName}-data`)] : [])
      ])
      for (const root of dataRoots) candidates.push(join(root, 'mason', 'bin', command))
    }
  }
  for (const candidate of new Set(candidates)) {
    try {
      await access(candidate, constants.X_OK)
      if ((await stat(candidate)).isFile()) return candidate
    } catch {
      // Missing entries, broken symlinks and invalid PATH directories are skipped.
    }
  }
  // vtsls speaks standard LSP over --stdio, like the TypeScript preset.
  if (!explicit && command === 'typescript-language-server')
    return resolveIdeExecutable('vtsls', env, cwd)
  return undefined
}
