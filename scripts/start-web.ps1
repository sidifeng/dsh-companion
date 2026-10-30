$ErrorActionPreference = 'Stop'
$localServices = Join-Path (Split-Path -Parent $PSScriptRoot) '.local\acestep\start-local-services.ps1'
if (Test-Path -LiteralPath $localServices) { & $localServices }
$listeners = @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) {
  $ownerId = $listeners[0].OwningProcess
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerId"
  if ($owner.CommandLine -match '[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js') {
    Write-Host "DeepSeek Harness is already running (PID $ownerId). Opening its existing page."
    Start-Process 'http://127.0.0.1:3080/'
    exit 0
  }
  throw "Port 3080 is already used by PID $ownerId. No additional DSH was started."
}
npx @deepseek-ai/dsh web
exit $LASTEXITCODE
