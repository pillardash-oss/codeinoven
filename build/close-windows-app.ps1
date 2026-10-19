param(
  [Parameter(Mandatory = $true)][string]$InstallDirectory,
  [Parameter(Mandatory = $true)][string]$LauncherFileName,
  [ValidateRange(0, 25)][int]$WaitSeconds = 0,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'

try {
  if ([IO.Path]::GetFileName($LauncherFileName) -ne $LauncherFileName) {
    throw 'The application executable name is invalid.'
  }
  $root = [IO.Path]::GetFullPath($InstallDirectory)
  $runtimeName = [IO.Path]::GetFileNameWithoutExtension($LauncherFileName) + '-electron.exe'
  $paths = @((Join-Path $root $LauncherFileName), (Join-Path $root $runtimeName))

  # NSIS is 32-bit even for a 64-bit installation. QueryFullProcessImageName
  # works across bitness and needs no WMI service or module. Keep the native
  # handle through verification and termination so PID reuse cannot kill a
  # different process. A process disappearing during inspection is success.
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class InstalledAppProcesses {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int id);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref int size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);

  public static int Inspect(string[] paths, bool stop) {
    int running = 0;
    foreach (string expected in paths) {
      foreach (Process candidate in Process.GetProcessesByName(System.IO.Path.GetFileNameWithoutExtension(expected))) {
        using (candidate) {
          IntPtr handle = OpenProcess(0x1000, false, candidate.Id);
          if (handle == IntPtr.Zero) {
            int error = Marshal.GetLastWin32Error();
            if (error == 87) continue;
            throw new Win32Exception(error, "Cannot inspect application process " + candidate.Id);
          }
          try {
            uint code;
            if (!GetExitCodeProcess(handle, out code)) throw new Win32Exception();
            if (code != 259) continue;
            var path = new StringBuilder(32768);
            int size = path.Capacity;
            if (!QueryFullProcessImageName(handle, 0, path, ref size)) {
              int error = Marshal.GetLastWin32Error();
              if (GetExitCodeProcess(handle, out code) && code != 259) continue;
              throw new Win32Exception(error);
            }
            if (!String.Equals(expected, path.ToString(), StringComparison.OrdinalIgnoreCase)) continue;
            running++;
            if (stop) {
              // Retain the query handle while opening the termination handle,
              // preventing reuse of this process id until both are closed.
              IntPtr kill = OpenProcess(0x1001, false, candidate.Id);
              if (kill == IntPtr.Zero) {
                if (GetExitCodeProcess(handle, out code) && code != 259) continue;
                throw new Win32Exception();
              }
              try {
                if (!TerminateProcess(kill, 0) && GetExitCodeProcess(handle, out code) && code == 259)
                  throw new Win32Exception();
              } finally { CloseHandle(kill); }
            }
          } finally { CloseHandle(handle); }
        }
      }
    }
    return running;
  }
}
'@

  $running = [InstalledAppProcesses]::Inspect($paths, $false)
  $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
  while ($running -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $running = [InstalledAppProcesses]::Inspect($paths, $false)
  }
  if ($running -eq 0) { exit 0 }
  if (-not $Stop) { exit 10 }

  # -Stop is only supplied after the installer's explicit close confirmation.
  [void][InstalledAppProcesses]::Inspect($paths, $true)
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 250
    if ([InstalledAppProcesses]::Inspect($paths, $false) -eq 0) { exit 0 }
  } while ([DateTime]::UtcNow -lt $deadline)
  exit 10
} catch {
  Write-Output $_.Exception.Message
  exit 1
}
