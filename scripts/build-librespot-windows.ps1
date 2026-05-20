# Builds librespot v0.8.0 on Windows and prints LIBRESPOT_PATH for GrokSlop .env
$ErrorActionPreference = "Stop"

$InstallRoot = if ($env:LIBRESPOT_INSTALL_DIR) { $env:LIBRESPOT_INSTALL_DIR } else { "C:\tools\librespot" }
$Tag = "v0.8.0"
$ExePath = Join-Path $InstallRoot "target\release\librespot.exe"

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Host "=== GrokSlop librespot Windows build ===" -ForegroundColor Cyan

if (-not (Test-Command "cargo")) {
    Write-Host "Rust/cargo not found. Install from https://rustup.rs then reopen PowerShell." -ForegroundColor Red
    exit 1
}

Write-Host "cargo: $(cargo --version)"
Write-Host "rustc: $(rustc --version)"

if (-not (Test-Path $InstallRoot)) {
    if (-not (Test-Command "git")) {
        Write-Host "Git not found. Clone manually or install Git, then re-run." -ForegroundColor Red
        Write-Host "  git clone --branch $Tag --depth 1 https://github.com/librespot-org/librespot.git `"$InstallRoot`""
        exit 1
    }
    Write-Host "Cloning librespot $Tag into $InstallRoot ..."
    git clone --branch $Tag --depth 1 https://github.com/librespot-org/librespot.git $InstallRoot
} else {
    Write-Host "Using existing folder: $InstallRoot"
}

Push-Location $InstallRoot
try {
    Write-Host "Building release (first run may take 10-20 minutes) ..."
    cargo build --release
    if (-not (Test-Path $ExePath)) {
        throw "Build finished but $ExePath was not found."
    }
    Write-Host ""
    Write-Host "Build OK:" -ForegroundColor Green
    Write-Host "  $ExePath"
    Write-Host ""
    Write-Host "Add to grokbot .env:" -ForegroundColor Yellow
    Write-Host "LIBRESPOT_PATH=$ExePath"
    Write-Host ""
    Write-Host "Quick test:"
    & $ExePath -h | Select-Object -First 5
} finally {
    Pop-Location
}
