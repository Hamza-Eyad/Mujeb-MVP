<#
.SYNOPSIS
  Starts the local phone lab: the Asterisk console (WSL) in a new window, then Mujeeb's
  telephony server in this window.

.DESCRIPTION
  Lab only (deploy/asterisk/lab/README.md). Asterisk keeps its configuration in /etc/asterisk,
  so this script only starts the two processes. It changes no configuration.

  Modes:
    exacall   A call from a phone to the provider's demo number, real providers.
              Routes: config/telephony/routes.local.json (not in git).
    microsip  MicroSIP extension 300, real providers. Routes: config/telephony/routes.json.
    fake      MicroSIP extension 300 with fake STT/LLM/TTS: no API keys, no cost.

  Without -Mode the script asks. Stop Mujeeb with Ctrl+C in this window, and Asterisk with
  `core stop now` in its console (or close that window).

  Console messages are in English on purpose: Windows consoles do not lay out Arabic text.

.EXAMPLE
  .\deploy\asterisk\lab\start-lab.ps1 -Mode exacall
#>
[CmdletBinding()]
param(
  [ValidateSet('exacall', 'microsip', 'fake')]
  [string]$Mode,
  [string]$Distro = 'Ubuntu-24.04'
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path

function Read-LabMode {
  Write-Host ''
  Write-Host 'Mujeeb phone lab'
  Write-Host '  1) ExaCall demo number: call from your phone (real providers, paid)'
  Write-Host '  2) MicroSIP extension 300 (real providers, paid)'
  Write-Host '  3) MicroSIP extension 300 (fake providers, no cost)'
  $choice = (Read-Host 'Choose 1, 2 or 3').Trim()
  switch ($choice) {
    '1' { return 'exacall' }
    '2' { return 'microsip' }
    '3' { return 'fake' }
    default { throw "Unknown choice '$choice'." }
  }
}

# The project targets Node 24. Returns a directory to put first on PATH, or $null if the
# node on PATH is already 24.
function Find-Node24Dir {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($node -and ((& $node.Source --version) -like 'v24.*')) { return $null }
  $installs = @(Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs') -Directory -Filter 'node-v24.*-win-x64' -ErrorAction SilentlyContinue |
      Sort-Object { [version]($_.Name -replace '^node-v(\d+\.\d+\.\d+).*$', '$1') } -Descending)
  if ($installs.Count -eq 0) {
    throw 'Node.js 24 was not found. Install it (winget install --id OpenJS.NodeJS.LTS -e), then run this again.'
  }
  return $installs[0].FullName
}

# Opens the Asterisk console in its own window. That window keeps the WSL distro running:
# closing it stops Asterisk.
function Start-AsteriskWindow {
  # `asterisk -rx` exits 0 even when no server answers, so look for the version line instead.
  $probe = "command -v asterisk >/dev/null || exit 3; asterisk -rx 'core show version' 2>/dev/null | grep -q '^Asterisk [0-9]' || exit 1"
  & wsl.exe -d $Distro -u root -- sh -c $probe
  switch ($LASTEXITCODE) {
    0 { Write-Host 'Asterisk is already running: opening its console in a new window.'; $console = '-rvvv' }
    1 { Write-Host 'Starting Asterisk in a new window.'; $console = '-cvvv' }
    3 { throw "Asterisk is not installed in WSL '$Distro'. See deploy/asterisk/lab/README.md." }
    default { throw "WSL distro '$Distro' did not start (exit code $LASTEXITCODE). Check it with: wsl -l -v" }
  }
  Start-Process -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '-u', 'root', '--', 'asterisk', $console)
}

# The port the gateway will listen on: the environment wins over .env, as with node --env-file.
function Get-GatewayPort {
  if ($env:MUJEEB_TELEPHONY_PORT) { return [int]$env:MUJEEB_TELEPHONY_PORT }
  $line = Get-Content -LiteralPath (Join-Path $repo '.env') -ErrorAction SilentlyContinue |
    Where-Object { $_ -match '^\s*MUJEEB_TELEPHONY_PORT\s*=' } | Select-Object -Last 1
  if ($line) { return [int](($line -split '=', 2)[1].Trim().Trim('"', "'")) }
  return 8790
}

try {
  if (-not $Mode) { $Mode = Read-LabMode }
  $routes = if ($Mode -eq 'exacall') { 'config/telephony/routes.local.json' } else { 'config/telephony/routes.json' }
  if (-not (Test-Path -LiteralPath (Join-Path $repo $routes))) {
    throw "Missing $routes. See deploy/asterisk/lab/README.md."
  }
  $nodeDir = Find-Node24Dir

  Start-AsteriskWindow

  $port = Get-GatewayPort
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "Port $port is already in use: Mujeeb is probably running in another window." -ForegroundColor Yellow
    Write-Host 'Keep using that one, or stop it (Ctrl+C) and run this again to switch mode.'
    exit 1
  }
}
catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}

$saved = @{
  Path     = $env:PATH
  Routes   = $env:MUJEEB_TELEPHONY_ROUTES
  Title    = $Host.UI.RawUI.WindowTitle
  Encoding = [Console]::OutputEncoding
}
$npmScript = if ($Mode -eq 'fake') { 'telephony:fake' } else { 'telephony' }
try {
  if ($nodeDir) { $env:PATH = "$nodeDir;$env:PATH" }
  $env:MUJEEB_TELEPHONY_ROUTES = $routes
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  $Host.UI.RawUI.WindowTitle = "Mujeeb telephony ($Mode)"
  Write-Host ''
  Write-Host "Mujeeb: npm run $npmScript, routes $routes"
  Write-Host 'Ready when the "telephony gateway:" line appears. Ctrl+C stops Mujeeb.'
  Write-Host ''
  Set-Location -LiteralPath $repo
  & npm.cmd run $npmScript
}
finally {
  $env:PATH = $saved.Path
  $env:MUJEEB_TELEPHONY_ROUTES = $saved.Routes
  $Host.UI.RawUI.WindowTitle = $saved.Title
  [Console]::OutputEncoding = $saved.Encoding
}
