import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '../..')
const sourceDirectory = join(scriptDirectory, 'native')
const staticIcon = join(repositoryRoot, 'src/renderer/static/icon.png')

function report(message) {
  process.stdout.write(`[native-splash] ${message}\n`)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    ...options
  })
  if (result.status !== 0) {
    throw new Error(
      `Command failed (${command} ${args.join(' ')}):\n${result.stdout ?? ''}${result.stderr ?? ''}`
    )
  }
  return result.stdout.trim()
}

function writeEmbeddedHeader(headerPath, version) {
  const bytes = readFileSync(staticIcon)
  const lines = []
  for (let offset = 0; offset < bytes.length; offset += 20) {
    lines.push(
      `  ${[...bytes.subarray(offset, offset + 20)]
        .map((value) => `0x${value.toString(16).padStart(2, '0')}`)
        .join(', ')}`
    )
  }
  const escapedVersion = version.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  writeFileSync(
    headerPath,
    `#ifndef CODEINOVEN_EMBEDDED_ICON_H\n#define CODEINOVEN_EMBEDDED_ICON_H\n\n#define CODEINOVEN_VERSION "v${escapedVersion}"\n#define CODEINOVEN_VERSION_WIDE L"v${escapedVersion}"\n#define CODEINOVEN_COMPANY "Pillardash Solutions Limited"\n#define CODEINOVEN_COMPANY_WIDE L"Pillardash Solutions Limited"\n\nstatic const unsigned char CODEINOVEN_ICON_PNG[] = {\n${lines.join(',\n')}\n};\nstatic const unsigned long CODEINOVEN_ICON_PNG_SIZE = sizeof(CODEINOVEN_ICON_PNG);\n\n#endif\n`
  )
}

function architectureName(arch) {
  const names = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']
  const name = names[arch]
  if (!name) throw new Error(`Unsupported native splash architecture: ${arch}`)
  return name
}

function compileMac(output, includeDirectory, arch) {
  const architecture = architectureName(arch)
  const architectureArgs =
    architecture === 'universal'
      ? ['-arch', 'arm64', '-arch', 'x86_64']
      : architecture === 'arm64'
        ? ['-arch', 'arm64']
        : ['-arch', 'x86_64']
  run('clang', [
    '-fobjc-arc',
    '-Os',
    ...architectureArgs,
    '-I',
    includeDirectory,
    join(sourceDirectory, 'launcher.m'),
    '-framework',
    'Cocoa',
    '-o',
    output
  ])
}

function compileLinux(output, includeDirectory) {
  const flags = run('pkg-config', ['--cflags', '--libs', 'gtk+-3.0']).split(/\s+/).filter(Boolean)
  run('cc', [
    '-std=c11',
    '-D_POSIX_C_SOURCE=200809L',
    '-Os',
    '-I',
    includeDirectory,
    join(sourceDirectory, 'launcher.c'),
    '-pthread',
    ...flags,
    '-o',
    output
  ])
}

function findVisualStudio() {
  const programFiles = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const vswhere = join(programFiles, 'Microsoft Visual Studio/Installer/vswhere.exe')
  return run(vswhere, [
    '-latest',
    '-products',
    '*',
    '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property',
    'installationPath'
  ])
}

function compileWindows(output, includeDirectory, arch, temporaryDirectory) {
  const architecture = architectureName(arch)
  const vcArchitecture =
    architecture === 'arm64' ? 'arm64' : architecture === 'ia32' ? 'x86' : 'x64'
  const vcvars = join(findVisualStudio(), 'VC/Auxiliary/Build/vcvarsall.bat')
  const batchPath = join(temporaryDirectory, 'compile-native-splash.cmd')
  const quote = (value) => `"${value.replaceAll('"', '""')}"`
  // The default vcvarsall toolset tracks the newest VS release (currently v145),
  // which may not be installed. Fall back to the widely-available v143 (14.51)
  // toolchain so the trivial launcher still compiles on machines without v145.
  writeFileSync(
    batchPath,
    `@echo off\r\ncall ${quote(vcvars)} ${vcArchitecture} >nul\r\nwhere cl.exe >nul 2>nul\r\nif not errorlevel 1 goto :compile\r\ncall ${quote(vcvars)} ${vcArchitecture} -vcvars_ver=14.51 >nul\r\nif errorlevel 1 exit /b %errorlevel%\r\n:compile\r\ncl.exe /nologo /EHsc /Os /MT /DUNICODE /D_UNICODE /I${quote(includeDirectory)} ${quote(join(sourceDirectory, 'launcher.cpp'))} /Fe:${quote(output)} /link /SUBSYSTEM:WINDOWS user32.lib gdi32.lib gdiplus.lib ole32.lib shell32.lib bcrypt.lib\r\n`
  )
  run('cmd.exe', ['/d', '/s', '/c', batchPath])
}

async function hardenElectron(electronExecutable, platform) {
  // Embedded ASAR integrity validation requires the Electron binary to be
  // Authenticode-signed on Windows: the integrity data is embedded in the
  // Authenticode signature by the packer's signing pass. Our Windows builds are
  // unsigned, so enabling the fuse there makes the child abort instantly at
  // startup (native splash flashes black and closes). macOS signs the bundle,
  // so the fuse stays on there.
  const enableAsarIntegrity = platform !== 'win32'
  await flipFuses(electronExecutable, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: enableAsarIntegrity,
    [FuseV1Options.OnlyLoadAppFromAsar]: enableAsarIntegrity,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: true
  })
}

export default async function installNativeSplash(context) {
  const platform = context.electronPlatformName
  const productFilename = context.packager.appInfo.productFilename
  const applicationVersion = context.packager.appInfo.version
  const executableName = context.packager.executableName ?? productFilename.toLowerCase()
  const temporaryDirectory = join(context.outDir, `native-splash-${platform}-${context.arch}`)
  rmSync(temporaryDirectory, { recursive: true, force: true })
  mkdirSync(temporaryDirectory, { recursive: true })
  writeEmbeddedHeader(join(temporaryDirectory, 'embedded_icon.h'), applicationVersion)

  let publicExecutable
  let electronExecutable
  let launcherExecutable
  if (platform === 'darwin' || platform === 'mas') {
    const macOsDirectory = join(context.appOutDir, `${productFilename}.app/Contents/MacOS`)
    publicExecutable = join(macOsDirectory, productFilename)
    electronExecutable = join(macOsDirectory, `${productFilename}-electron`)
    launcherExecutable = join(temporaryDirectory, productFilename)
    compileMac(launcherExecutable, temporaryDirectory, context.arch)
  } else if (platform === 'win32') {
    publicExecutable = join(context.appOutDir, `${productFilename}.exe`)
    electronExecutable = join(context.appOutDir, `${productFilename}-electron.exe`)
    launcherExecutable = join(temporaryDirectory, `${productFilename}.exe`)
    compileWindows(launcherExecutable, temporaryDirectory, context.arch, temporaryDirectory)
  } else if (platform === 'linux') {
    publicExecutable = join(context.appOutDir, executableName)
    electronExecutable = join(context.appOutDir, `${executableName}-electron`)
    launcherExecutable = join(temporaryDirectory, executableName)
    compileLinux(launcherExecutable, temporaryDirectory)
  } else {
    throw new Error(`Unsupported native splash platform: ${platform}`)
  }

  // Fuses belong to Electron, not the tiny public launcher. Apply them while
  // the original binary still has its standard packaged location, then rename
  // it and let electron-builder sign both executables in its normal sign pass.
  await hardenElectron(publicExecutable, platform)
  renameSync(publicExecutable, electronExecutable)
  copyFileSync(launcherExecutable, publicExecutable)
  chmodSync(publicExecutable, 0o755)
  chmodSync(electronExecutable, 0o755)
  report(`installed ${platform}/${architectureName(context.arch)} launcher`)
}
