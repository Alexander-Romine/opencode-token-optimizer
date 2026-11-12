<#
.SYNOPSIS
  Removes the token-optimizer plugin registration from an OpenCode config file.

.DESCRIPTION
  Backs up the config first, then removes only this plugin's entry. Nothing else
  is touched. Dependencies, the native addon and state files are left in place;
  delete the folder manually if you want a full removal.

.EXAMPLE
  .\uninstall.ps1            # project config in the current directory
  .\uninstall.ps1 -Global    # global ~/.config/opencode config
#>
[CmdletBinding()]
param(
    [switch]$Global
)

$ErrorActionPreference = "Stop"
$repo = $PSScriptRoot

if ($Global) {
    $configDir = Join-Path $env:USERPROFILE ".config\opencode"
} else {
    $configDir = Get-Location
}

$configPath = $null
foreach ($name in @("opencode.json", "opencode.jsonc")) {
    $candidate = Join-Path $configDir $name
    if (Test-Path $candidate) { $configPath = $candidate; break }
}

if (-not $configPath) {
    Write-Host "No opencode config found in $configDir - nothing to remove." -ForegroundColor Yellow
    exit 0
}

$packagePath = ($repo -replace "\\", "/")

$raw = Get-Content $configPath -Raw
try {
    $config = $raw | ConvertFrom-Json
} catch {
    Write-Host "Could not parse $configPath - remove the entry manually." -ForegroundColor Red
    exit 1
}

if ($config.PSObject.Properties.Name -notcontains "plugins") {
    Write-Host "No plugins registered in $configPath - nothing to remove." -ForegroundColor Yellow
    exit 0
}

$kept = @()
$removed = 0
foreach ($item in @($config.plugins)) {
    $pkg = $null
    if ($item -is [string]) { $pkg = $item }
    elseif ($item.PSObject.Properties.Name -contains "package") { $pkg = $item.package }
    if ($pkg -and (($pkg -replace "\\", "/") -eq $packagePath)) {
        $removed++
    } else {
        $kept += $item
    }
}

if ($removed -eq 0) {
    Write-Host "token-optimizer is not registered in $configPath." -ForegroundColor Yellow
    exit 0
}

$backup = "$configPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item $configPath $backup
Write-Host "Backed up -> $backup" -ForegroundColor Green

$config | Add-Member -NotePropertyName "plugins" -NotePropertyValue $kept -Force
$json = ($config | ConvertTo-Json -Depth 20) -replace "\\\/", "/"
# No BOM - see install.ps1.
[System.IO.File]::WriteAllText($configPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Removed token-optimizer from $configPath ($removed entry)." -ForegroundColor Green
Write-Host "Restart OpenCode for the change to take effect."
