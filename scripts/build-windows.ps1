param()
$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Build machine requires Node.js 22 or newer. End users do not need Node.js installed.' }
  & node scripts/build-windows.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Windows packaging failed.' }
} finally { Pop-Location }
