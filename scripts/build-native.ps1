<#
  Builds the token-optimizer Rust addon and installs it where the plugin loads
  it from (native/token-optimizer.node).

  The cargo target directory is redirected outside the project on purpose:
  a Rust build emits thousands of small files, which is exactly what you do
  not want a sync client (OneDrive/Dropbox) chasing.
#>
$ErrorActionPreference = "Stop"

$native = Join-Path $PSScriptRoot "..\native"
$manifest = Join-Path $native "Cargo.toml"
$outName = "token-optimizer.node"

if (-not $env:TOKEN_OPTIMIZER_TARGET) {
    $env:TOKEN_OPTIMIZER_TARGET = Join-Path $env:LOCALAPPDATA "Temp\opencode\cargo-target"
}
$env:CARGO_TARGET_DIR = $env:TOKEN_OPTIMIZER_TARGET

Push-Location $native
try {
    Write-Host "cargo build --release  (target: $env:CARGO_TARGET_DIR)"
    cargo build --release --manifest-path $manifest
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }

    $dll = Join-Path $env:CARGO_TARGET_DIR "release\token_optimizer_native.dll"
    if (-not (Test-Path $dll)) { throw "expected build output not found: $dll" }

    $dest = Join-Path $native $outName
    Copy-Item -Path $dll -Destination $dest -Force

    $kb = [math]::Round((Get-Item $dest).Length / 1kb)
    Write-Host "installed $dest ($kb KB)"
}
finally {
    Pop-Location
}
