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
import { renderNativeSplash } from './artwork.js'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '../..')
const sourceDirectory = join(scriptDirectory, 'native')

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

export function writeEmbeddedHeader(headerPath, version, runtimeExecutable) {
  const bytes = renderNativeSplash(repositoryRoot, version)
  const lines = []
  for (let offset = 0; offset < bytes.length; offset += 20) {
    lines.push(
      `  ${[...bytes.subarray(offset, offset + 20)]
        .map((value) => `0x${value.toString(16).padStart(2, '0')}`)
        .join(', ')}`
    )
  }
  const escape = (value) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  const escapedVersion = escape(version)
  // The runtime's file name is a per-platform fact the launcher cannot guess,
  // so it is compiled in rather than duplicated in three sources.
  const escapedRuntime = escape(runtimeExecutable)
  writeFileSync(
    headerPath,
    `#ifndef CODEINOVEN_EMBEDDED_ICON_H\n#define CODEINOVEN_EMBEDDED_ICON_H\n\n#define CODEINOVEN_VERSION "v${escapedVersion}"\n#define CODEINOVEN_VERSION_WIDE L"v${escapedVersion}"\n#define CODEINOVEN_COMPANY "Pillardash Solutions Limited"\n#define CODEINOVEN_COMPANY_WIDE L"Pillardash Solutions Limited"\n#define CODEINOVEN_RUNTIME_EXECUTABLE "${escapedRuntime}"\n#define CODEINOVEN_RUNTIME_EXECUTABLE_WIDE L"${escapedRuntime}"\n\nstatic const unsigned char CODEINOVEN_ICON_PNG[] = {\n${lines.join(',\n')}\n};\nstatic const unsigned long CODEINOVEN_ICON_PNG_SIZE = sizeof(CODEINOVEN_ICON_PNG);\n\n#endif\n`
  )
}

/**
 * The launcher is the only executable Windows shows users (Explorer, taskbar,
 * Start menu shortcut and toast notifications all resolve it), so it needs the
 * icon and version block the build stamps into the runtime. electron-builder
 * stamps the Electron binary before this hook runs, and the runtime keeps that
 * stamp when it is moved aside, which would otherwise leave the visible
 * executable with a generic icon and no version.
 */
function writeWindowsResources(resourceScriptPath, version, productFilename) {
  const [major = '0', minor = '0', patch = '0'] = version.split('.')
  const segment = (value) => String(Number.parseInt(value.replace(/\D/gu, ''), 10) || 0)
  const numericVersion = `${segment(major)},${segment(minor)},${segment(patch)},0`
  const iconPath = join(repositoryRoot, 'build', 'icon.ico')
  writeFileSync(
    resourceScriptPath,
    `#include <windows.h>\n\n1 ICON "${iconPath.replaceAll('\\', '\\\\')}"\n\nVS_VERSION_INFO VERSIONINFO\n FILEVERSION ${numericVersion}\n PRODUCTVERSION ${numericVersion}\n FILEFLAGSMASK 0x3fL\n FILEFLAGS 0x0L\n FILEOS 0x40004L\n FILETYPE 0x1L\n FILESUBTYPE 0x0L\nBEGIN\n  BLOCK "StringFileInfo"\n  BEGIN\n    BLOCK "040904b0"\n    BEGIN\n      VALUE "CompanyName", "Pillardash Solutions Limited"\n      VALUE "FileDescription", "${productFilename}"\n      VALUE "FileVersion", "${version}"\n      VALUE "InternalName", "${productFilename}"\n      VALUE "OriginalFilename", "${productFilename}.exe"\n      VALUE "ProductName", "${productFilename}"\n      VALUE "ProductVersion", "${version}"\n    END\n  END\n  BLOCK "VarFileInfo"\n  BEGIN\n    VALUE "Translation", 0x409, 1200\n  END\nEND\n`
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

function compileWindows(output, includeDirectory, arch, temporaryDirectory, version, productFilename) {
  const architecture = architectureName(arch)
  const vcArchitecture =
    architecture === 'arm64' ? 'arm64' : architecture === 'ia32' ? 'x86' : 'x64'
  const vcvars = join(findVisualStudio(), 'VC/Auxiliary/Build/vcvarsall.bat')
  const batchPath = join(temporaryDirectory, 'compile-native-splash.cmd')
  const resourceScript = join(temporaryDirectory, 'native-splash.rc')
  const resourceObject = join(temporaryDirectory, 'native-splash.res')
  writeWindowsResources(resourceScript, version, productFilename)
  const quote = (value) => `"${value.replaceAll('"', '""')}"`
  // The default vcvarsall toolset tracks the newest VS release (currently v145),
  // which may not be installed. Fall back to the widely-available v143 (14.51)
  // toolchain so the trivial launcher still compiles on machines without v145.
  writeFileSync(
    batchPath,
    `@echo off\r\ncall ${quote(vcvars)} ${vcArchitecture} >nul\r\nwhere cl.exe >nul 2>nul\r\nif not errorlevel 1 goto :compile\r\ncall ${quote(vcvars)} ${vcArchitecture} -vcvars_ver=14.51 >nul\r\nif errorlevel 1 exit /b %errorlevel%\r\n:compile\r\nrc.exe /nologo /fo ${quote(resourceObject)} ${quote(resourceScript)}\r\nif errorlevel 1 exit /b %errorlevel%\r\ncl.exe /nologo /EHsc /Os /MT /DUNICODE /D_UNICODE /I${quote(includeDirectory)} ${quote(join(sourceDirectory, 'launcher.cpp'))} /Fe:${quote(output)} /link /SUBSYSTEM:WINDOWS user32.lib gdi32.lib gdiplus.lib ole32.lib shell32.lib bcrypt.lib ${quote(resourceObject)}\r\n`
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

  // macOS keeps the Electron runtime as the bundle's main executable, because
  // that process *is* the product: it owns the windows, the menu bar item, the
  // browser, meetings, capture permissions and every agent run, and its name is
  // the name the OS shows (Dock, Applications folder, privacy dialogs, Activity
  // Monitor) and the folder name Squirrel's installer writes into /Applications.
  // The splash therefore becomes a helper the app spawns, never the entry point.
  //
  // Windows and Linux launch through the tiny supervisor, so there it stays the
  // public executable and the runtime keeps a distinct internal name.
  let runtimeExecutableName
  let publicExecutable
  let electronExecutable
  let launcherExecutable
  const isMac = platform === 'darwin' || platform === 'mas'
  if (isMac) {
    const contentsDirectory = join(context.appOutDir, `${productFilename}.app/Contents`)
    // `Contents/Helpers` is a nested-code location the macOS signer understands,
    // so the splash is sealed as a helper before the main executable.
    runtimeExecutableName = productFilename
    publicExecutable = join(contentsDirectory, 'Helpers', `${productFilename} Splash`)
    electronExecutable = join(contentsDirectory, 'MacOS', productFilename)
    launcherExecutable = join(temporaryDirectory, `${productFilename} Splash`)
    mkdirSync(join(contentsDirectory, 'Helpers'), { recursive: true })
  } else if (platform === 'win32') {
    runtimeExecutableName = `${productFilename}-electron.exe`
    publicExecutable = join(context.appOutDir, `${productFilename}.exe`)
    electronExecutable = join(context.appOutDir, runtimeExecutableName)
    launcherExecutable = join(temporaryDirectory, `${productFilename}.exe`)
  } else if (platform === 'linux') {
    runtimeExecutableName = `${executableName}-electron`
    publicExecutable = join(context.appOutDir, executableName)
    electronExecutable = join(context.appOutDir, runtimeExecutableName)
    launcherExecutable = join(temporaryDirectory, executableName)
  } else {
    throw new Error(`Unsupported native splash platform: ${platform}`)
  }

  writeEmbeddedHeader(
    join(temporaryDirectory, 'embedded_icon.h'),
    applicationVersion,
    runtimeExecutableName
  )
  if (isMac) {
    compileMac(launcherExecutable, temporaryDirectory, context.arch)
  } else if (platform === 'win32') {
    compileWindows(
      launcherExecutable,
      temporaryDirectory,
      context.arch,
      temporaryDirectory,
      applicationVersion,
      productFilename
    )
  } else {
    compileLinux(launcherExecutable, temporaryDirectory)
  }

  // Fuses belong to Electron. macOS already has the runtime at its final name;
  // Windows and Linux move it aside just below, so they must be flipped while it
  // still sits at the path electron-builder created. Opening the post-rename
  // path here fails with ENOENT because the rename has not happened yet.
  await hardenElectron(isMac ? electronExecutable : publicExecutable, platform)
  if (isMac) {
    // The plist already names the Electron runtime; assert it so a packaging
    // change can never silently rename what users see again.
    const plistPath = join(context.appOutDir, `${productFilename}.app/Contents/Info.plist`)
    const plist = readFileSync(plistPath, 'utf8')
    const executableEntry = /(<key>CFBundleExecutable<\/key>\s*<string>)([^<]*)(<\/string>)/
    const current = executableEntry.exec(plist)
    if (current === null) throw new Error('Missing macOS bundle executable')
    if (current[2] !== productFilename) {
      writeFileSync(plistPath, plist.replace(executableEntry, `$1${productFilename}$3`))
    }
    copyFileSync(launcherExecutable, publicExecutable)
    chmodSync(publicExecutable, 0o755)
  } else {
    renameSync(publicExecutable, electronExecutable)
    copyFileSync(launcherExecutable, publicExecutable)
    chmodSync(publicExecutable, 0o755)
    chmodSync(electronExecutable, 0o755)
  }
  report(`installed ${platform}/${architectureName(context.arch)} splash (${runtimeExecutableName})`)
}
