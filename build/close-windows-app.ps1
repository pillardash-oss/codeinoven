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
  $launcherQuery = $LauncherFileName.Replace("'", "''")
  $runtimeQuery = $runtimeName.Replace("'", "''")
  $filter = "Name = '$launcherQuery' OR Name = '$runtimeQuery'"

  function Get-InstalledAppProcesses {
    @(Get-CimInstance -ClassName Win32_Process -Filter $filter | Where-Object {
      if (-not $_.ExecutablePath) {
        throw "Cannot inspect application process $($_.ProcessId). Close it manually or run the installer with permission to inspect it."
      }
      $paths -contains $_.ExecutablePath
    })
  }

  $running = @(Get-InstalledAppProcesses)
  # Updates wait for the complete shutdown pipeline and launcher supervisor.
  $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
  while ($running.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $running = @(Get-InstalledAppProcesses)
  }
  if ($running.Count -eq 0) { exit 0 }
  if (-not $Stop) { exit 10 }

  # Allow the updater's normal shutdown to flush data before forced cleanup.
  Start-Sleep -Seconds 5
  foreach ($candidate in @(Get-InstalledAppProcesses)) {
    $live = Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $live) { continue }
    # Recheck the live handle so a reused PID cannot target another application.
    if ($paths -notcontains $live.Path) { throw 'The application process path changed.' }
    Stop-Process -InputObject $live -Force
  }
  Start-Sleep -Milliseconds 300
  if (@(Get-InstalledAppProcesses).Count -gt 0) { exit 10 }
  exit 0
} catch {
  Write-Output $_.Exception.Message
  exit 1
}
