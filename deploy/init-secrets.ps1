[CmdletBinding()]
param(
  [string]$SecretsDir = (Join-Path $PSScriptRoot '..\.secrets'),
  [string]$AppPassword
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $SecretsDir | Out-Null

function New-SecretValue {
  $bytes = [byte[]]::new(48)
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return [Convert]::ToBase64String($bytes)
}

function Write-SecretIfMissing([string]$Name, [string]$Value) {
  $target = Join-Path $SecretsDir $Name
  if (Test-Path -LiteralPath $target) {
    Write-Host "$target already exists; left unchanged."
    return $false
  }
  [System.IO.File]::WriteAllText($target, $Value, [System.Text.UTF8Encoding]::new($false))
  Write-Host "Created $target"
  return $true
}

[void](Write-SecretIfMissing 'internal_token' (New-SecretValue))
[void](Write-SecretIfMissing 'app_key' (New-SecretValue))

$passwordPath = Join-Path $SecretsDir 'app_password'
if (Test-Path -LiteralPath $passwordPath) {
  Write-Host "$passwordPath already exists; left unchanged."
} elseif ($PSBoundParameters.ContainsKey('AppPassword')) {
  [void](Write-SecretIfMissing 'app_password' $AppPassword)
} else {
  $generatedPassword = New-SecretValue
  [void](Write-SecretIfMissing 'app_password' $generatedPassword)
  Write-Host "Store this generated application password now: $generatedPassword"
}
