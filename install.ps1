<#
.SYNOPSIS
  Installs the token-optimizer plugin for OpenCode.

.DESCRIPTION
  What it does, in order:
    1. Checks prerequisites (Node.js; Rust is optional - a prebuilt addon ships
       with the repo, and without either the plugin still runs on its JS fallback).
    2. Installs npm dependencies.
    3. Installs the native addon: builds it with cargo when available,
       otherwise copies the bundled prebuilt binary, otherwise skips (JS fallback).
    4. Registers the plugin in your OpenCode config (project opencode.json, or
       the global ~/.config/opencode/opencode.json with -Global). Existing
       config is backed up first and merged, never overwritten.
    5. Runs the smoke test so you know it actually works before opening OpenCode.

.EXAMPLE
  .\install.ps1                  # project-level install (current directory)
  .\install.ps1 -Global          # register for every project
  .\install.ps1 -SkipNative      # skip the native addon entirely
#>
[CmdletBinding()]
param(
    [switch]$Global,
    [switch]$SkipNative,
    [switch]$SkipConfig
)

$ErrorActionPreference = "Stop"
$repo = $PSScriptRoot

function Step($msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg)    { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "    $msg" -ForegroundColor Yellow }
function Fail($msg)  { Write-Host "    $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "token-optimizer installer" -ForegroundColor White
Write-Host "repo: $repo"
Write-Host ""

# ---------------------------------------------------------------- 1. prereqs
Step "Checking prerequisites"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Fail "Node.js is required but was not found on PATH."
    Fail "Install it from https://nodejs.org and re-run this script."
    exit 1
}
$nodeVersion = (& node --version) -replace "^v", ""
$nodeMajor = [int]($nodeVersion -split "\.")[0]
if ($nodeMajor -lt 18) {
    Fail "Node.js 18+ required, found $nodeVersion."
    exit 1
}
Ok "Node.js v$nodeVersion"

$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if ($cargo) {
    # rustup can be present but broken (no default toolchain) - verify it runs.
    # The probe must not inherit EAP=Stop: PS 5.1 turns redirected native stderr
    # into a terminating error.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $cargoVersion = $null
    try {
        $cargoVersion = & cargo --version 2>$null
        if ($LASTEXITCODE -ne 0) { $cargoVersion = $null }
    } catch {
        $cargoVersion = $null
    }
    $ErrorActionPreference = $prevEap

    if ($cargoVersion) {
        Ok "Rust toolchain found ($cargoVersion)"
    } else {
        Warn "cargo found but not runnable - will use the prebuilt addon (or JS fallback)."
        $cargo = $false
    }
} else {
    Warn "Rust not found - will use the prebuilt addon (or JS fallback)."
    Warn "Install from https://rustup.rs to build from source."
}

# ------------------------------------------------------------ 2. npm install
Step "Installing npm dependencies"
Push-Location $repo
try {
    # -SkipNative must reach postinstall, otherwise it would build anyway.
    $prevSkip = $env:TOKEN_OPTIMIZER_SKIP_NATIVE
    if ($SkipNative) { $env:TOKEN_OPTIMIZER_SKIP_NATIVE = "1" }
    & npm install --no-fund --no-audit
    $npmExit = $LASTEXITCODE
    if ($null -eq $prevSkip) { Remove-Item Env:TOKEN_OPTIMIZER_SKIP_NATIVE -ErrorAction SilentlyContinue }
    else { $env:TOKEN_OPTIMIZER_SKIP_NATIVE = $prevSkip }
    if ($npmExit -ne 0) { throw "npm install failed with exit code $npmExit" }
    Ok "dependencies ready"
} finally {
    Pop-Location
}

# --------------------------------------------------------- 3. native addon
$addonPath = Join-Path $repo "native\token-optimizer.node"
$installedNative = $false

if ($SkipNative) {
    Warn "Skipping native addon (-SkipNative). JS fallback will be used."
} elseif (Test-Path $addonPath) {
    Ok "Native addon already present: $addonPath"
    $installedNative = $true
} elseif ($cargo) {
    Step "Building Rust addon (release)"
    Push-Location $repo
    try {
        & powershell -ExecutionPolicy Bypass -File (Join-Path $repo "scripts\build-native.ps1")
        if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }
        $installedNative = Test-Path $addonPath
        if ($installedNative) { Ok "native addon built and installed" }
    } catch {
        Warn "Native build failed: $_"
        Warn "The plugin will use the JS fallback (same results, ~3x slower)."
    } finally {
        Pop-Location
    }
} else {
    $prebuilt = Join-Path $repo "prebuilt\win32-x64\token-optimizer.node"
    if (Test-Path $prebuilt) {
        New-Item -ItemType Directory -Path (Split-Path $addonPath) -Force | Out-Null
        Copy-Item $prebuilt $addonPath -Force
        $installedNative = $true
        Ok "Copied bundled prebuilt addon (win32-x64)"
    } else {
        Warn "No prebuilt addon for this platform. JS fallback will be used."
    }
}

# -------------------------------------------------------------- 4. config
if (-not $SkipConfig) {
    Step "Registering plugin in OpenCode config"

    if ($Global) {
        $configDir = Join-Path $env:USERPROFILE ".config\opencode"
        $configPath = $null
        foreach ($name in @("opencode.json", "opencode.jsonc")) {
            $candidate = Join-Path $configDir $name
            if (Test-Path $candidate) { $configPath = $candidate; break }
        }
        if (-not $configPath) { $configPath = Join-Path $configDir "opencode.json" }
    } else {
        $configDir = Get-Location
        $configPath = $null
        foreach ($name in @("opencode.json", "opencode.jsonc")) {
            $candidate = Join-Path $configDir $name
            if (Test-Path $candidate) { $configPath = $candidate; break }
        }
        if (-not $configPath) { $configPath = Join-Path $configDir "opencode.json" }
    }

    # Forward slashes keep the path valid in JSON on every platform.
    $packagePath = $repo -replace "\\", "/"

    $entry = [ordered]@{
        package = $packagePath
        options  = [ordered]@{
            enabled        = $true
            charsPerToken  = 4
            tool           = [ordered]@{
                maxChars        = 24000
                headPct         = 70
                stripAnsi       = $true
                collapseBlank   = $true
                maxBlankLines   = 1
                trimLines       = $false
                dedupeWindow    = 4
                dedupeMinChars  = 1500
                exclude         = @("write", "edit", "apply_patch")
            }
            rotation       = [ordered]@{
                auto          = $true
                thresholdPct  = 85
                titleSuffix   = " (rotated)"
            }
            routing        = [ordered]@{
                title      = ""
                compaction = ""
                generate   = ""
                agents     = [ordered]@{}
            }
            budgetMaxTokens = 0
            stateDir       = ".opencode/token-optimizer/state"
        }
    }

    $existing = @()
    $hadConfig = Test-Path $configPath
    if ($hadConfig) {
        # Back up before touching anything.
        $backup = "$configPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Copy-Item $configPath $backup
        Ok "Backed up existing config -> $backup"

        $raw = Get-Content $configPath -Raw
        if ([string]::IsNullOrWhiteSpace($raw)) {
            $raw = "{}"
        }
        try {
            $config = $raw | ConvertFrom-Json
        } catch {
            Fail "Could not parse existing config as JSON: $configPath"
            Fail "It may contain comments (JSONC). Add this entry manually:"
            Fail ($entry | ConvertTo-Json -Depth 10)
            exit 1
        }
        if ($null -eq $config) { $config = [pscustomobject]@{} }
        if ($config.PSObject.Properties.Name -contains "plugins") {
            $existing = @($config.plugins)
        }
    } else {
        $config = [pscustomobject]@{}
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }

    # Replace an existing entry for this same package, else append.
    $merged = @()
    $replaced = $false
    foreach ($item in $existing) {
        $pkg = $null
        if ($item -is [string]) { $pkg = $item }
        elseif ($item.PSObject.Properties.Name -contains "package") { $pkg = $item.package }
        if ($pkg -and (($pkg -replace "\\", "/") -eq $packagePath)) {
            $merged += (ConvertTo-Json $entry -Depth 10 | ConvertFrom-Json)
            $replaced = $true
        } else {
            $merged += $item
        }
    }
    if (-not $replaced) {
        $merged += (ConvertTo-Json $entry -Depth 10 | ConvertFrom-Json)
    }

    $config | Add-Member -NotePropertyName "plugins" -NotePropertyValue $merged -Force

    $json = $config | ConvertTo-Json -Depth 20
    # ConvertTo-Json escapes forward slashes in some versions; JSON-legal but noisy.
    $json = $json -replace "\\\/", "/"
    # No BOM: Windows PowerShell 5.1's Set-Content -Encoding UTF8 adds one, and
    # a BOM makes strict JSON parsers reject the file.
    [System.IO.File]::WriteAllText($configPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
    Ok "Registered plugin in $configPath"
    if (-not $installedNative) {
        Warn "Running on the JS fallback - results identical, ~3x slower."
    }
}

# ----------------------------------------------------------- 5. smoke test
Step "Running smoke test"
Push-Location $repo
try {
    & node (Join-Path $repo "test\smoke.mjs")
    if ($LASTEXITCODE -ne 0) {
        Fail "Smoke test failed - the plugin may not work correctly."
        exit 1
    }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "Install complete." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
if ($Global) {
    Write-Host "  * Restart OpenCode - the plugin loads for every project."
} else {
    Write-Host "  * Start OpenCode from this directory - the plugin loads for this project."
}
Write-Host "  * In the TUI, run /tokens for the efficiency report."
Write-Host "  * Run /rotate to start a fresh session seeded from the current one's state."
Write-Host "  * Auto-rotation is ON: a fresh session starts at 85% of the context window."
Write-Host "    Change options.rotation.auto in your config to disable it."
Write-Host ""
