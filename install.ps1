$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot 'aigirl-quota'
$dstRoot = Join-Path $env:USERPROFILE '.gemini\config\plugins'
$dst = Join-Path $dstRoot 'aigirl-quota'

if (-not (Test-Path $src)) {
    throw "Source plugin directory not found: $src"
}

New-Item -ItemType Directory -Force -Path $dst | Out-Null
# Copy contents in-place so an active sidecar CWD lock does not fail directory removal
Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force
Write-Host "Installed / updated aigirl-quota at: $dst" -ForegroundColor Green
