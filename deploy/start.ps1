[CmdletBinding()]
param(
  [switch]$Detached,
  [switch]$ChatGPT,
  [string]$AppPassword
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw '请先安装并启动 Docker Desktop，并选择 Linux 容器，再运行此脚本。'
}
$engineType = & docker info --format '{{.OSType}}' 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace("$engineType")) {
  throw 'Docker 引擎尚未就绪。请打开 Docker Desktop，完成首次设置并等待 Engine running，再运行此脚本。'
}
if (("$engineType").Trim() -ne 'linux') {
  throw '此项目需要 Linux 容器。请在 Docker Desktop 中切换到 Linux containers。'
}
$projectDir = Split-Path -Parent $PSScriptRoot
if ($PSBoundParameters.ContainsKey('AppPassword')) {
  & (Join-Path $PSScriptRoot 'init-secrets.ps1') -AppPassword $AppPassword
} else {
  & (Join-Path $PSScriptRoot 'init-secrets.ps1')
}
Push-Location $projectDir
try {
  $arguments = @('compose', '-f', 'compose.yaml')
  if ($ChatGPT) { $arguments += @('--profile', 'chatgpt') }
  $arguments += @('up', '--build')
  if ($Detached) { $arguments += '--detach' }
  & docker @arguments
  if ($LASTEXITCODE -ne 0) { throw "Docker Compose 启动失败（退出码 $LASTEXITCODE）。请查看上方错误。" }
} finally {
  Pop-Location
}
