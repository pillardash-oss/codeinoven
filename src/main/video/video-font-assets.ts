import { app } from 'electron'
import { copyFile, mkdir, readFile, readdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite } from '../../lib/utils'
import { videoFolder } from './video-paths'

/** Reuse the app's bundled faces so preview and exported captions have the same fonts. */
export async function installVideoFonts(folder: string): Promise<void> {
  const root = app.getAppPath(),
    bundled = join(root, 'out', 'renderer', 'assets')
  const files = (await readdir(bundled).catch(() => [])).slice(0, 3000)
  const faces = [
    {
      family: 'Oven Box',
      prefix: 'oven-box',
      fallback: join(root, 'resources', 'fonts', 'oven', 'oven-box.woff2')
    },
    {
      family: 'Oven Mono',
      prefix: 'oven-mono',
      fallback: join(root, 'resources', 'fonts', 'oven', 'oven-mono.woff2')
    },
    {
      family: 'JetBrains Mono Variable',
      prefix: 'jetbrains-mono-latin-wght-normal',
      fallback: join(
        root,
        'node_modules',
        '@fontsource-variable',
        'jetbrains-mono',
        'files',
        'jetbrains-mono-latin-wght-normal.woff2'
      )
    }
  ]
  await mkdir(join(folder, 'assets'), { recursive: true })
  await videoFolder(folder, 'assets')
  await mkdir(join(folder, 'assets', 'cio-fonts'), { recursive: true })
  const destination = await videoFolder(folder, 'assets/cio-fonts')
  const css: string[] = []
  for (const face of faces) {
    const name = files.find((name) => name.startsWith(`${face.prefix}-`) && name.endsWith('.woff2'))
    const source = name ? join(bundled, name) : face.fallback
    const metadata = await stat(source).catch(() => null)
    if (!metadata?.isFile() || metadata.size > 2 * 1024 * 1024) continue
    const filename = `${face.prefix}.woff2`,
      output = join(destination, filename)
    const previous = await stat(output).catch(() => null)
    if (previous?.size !== metadata.size) {
      const temporary = `${output}.incoming`
      await copyFile(source, temporary)
      await rename(temporary, output)
    }
    css.push(
      `@font-face{font-family:'${face.family}';font-style:normal;font-weight:100 900;font-display:block;src:url('./${filename}') format('woff2')}`
    )
  }
  const path = join(destination, 'fonts.css'),
    content = css.join('\n')
  if ((await readFile(path, 'utf8').catch(() => '')) !== content) await atomicWrite(path, content)
}
