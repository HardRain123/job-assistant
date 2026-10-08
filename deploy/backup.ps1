[CmdletBinding()]
param(
  [string]$AppUrl = 'http://127.0.0.1:3000',
  [string]$AppPassword,
  [string]$BackupDir = (Join-Path $PSScriptRoot '..\backups')
)

$ErrorActionPreference = 'Stop'
if (-not $AppPassword) { $AppPassword = $env:APP_PASSWORD }
if (-not $AppPassword) {
  $secure = Read-Host 'Workbench password' -AsSecureString
  $AppPassword = [System.Net.NetworkCredential]::new('', $secure).Password
}
if (-not $AppPassword) { throw 'Workbench password is required.' }
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$temporary = Join-Path $BackupDir ".job-assistant-$stamp.sqlite.part"
$target = Join-Path $BackupDir "job-assistant-$stamp.sqlite"

try {
  $loginBody = @{ password = $AppPassword } | ConvertTo-Json -Compress
  $null = Invoke-WebRequest -Method Post -Uri "$AppUrl/api/login" -ContentType 'application/json' -Body $loginBody -SessionVariable session
  $null = Invoke-WebRequest -Method Post -Uri "$AppUrl/api/backup" -WebSession $session -OutFile $temporary
  Move-Item -LiteralPath $temporary -Destination $target
  Write-Host "Consistent SQLite backup written to $target"
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
