# Stop only the optional Docling process started from this workspace.

$ErrorActionPreference = "Stop"
$port = 5001
$connection = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $connection) {
  "Docling already stopped."
  exit 0
}

$doclingPid = $connection.OwningProcess
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$doclingPid"
if (-not $process -or
    $process.CommandLine -notmatch "docling-serve" -or
    $process.CommandLine -notmatch "anything-llm\\.local-cache\\docling-venv") {
  throw "Port 5001 is owned by an unexpected process (pid=$doclingPid); refusing to stop it."
}

try {
  Invoke-WebRequest "http://127.0.0.1:5001/v1/clear/converters" -TimeoutSec 10 -UseBasicParsing | Out-Null
} catch {
  # The service may already be shutting down; stopping it is still safe.
}

Stop-Process -Id $doclingPid
$deadline = (Get-Date).AddSeconds(15)
do {
  Start-Sleep -Seconds 1
  $connection = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
} while ($connection -and (Get-Date) -lt $deadline)

if ($connection) {
  throw "Docling did not release port 5001."
}

"Docling stopped (pid=$doclingPid)."
