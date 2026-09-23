$ErrorActionPreference = 'Stop'
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) {
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
}
Set-Location -Path $ScriptDir

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js 20+ is required. Install it from https://nodejs.org"
    exit 1
}

node setup.mjs $args
exit $LASTEXITCODE
