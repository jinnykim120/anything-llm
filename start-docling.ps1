# Start the optional Docling parser on the D:-hosted Python environment.
# Native ONNX reranking remains the default; run this only for a rich ingest
# session. Models load on demand and are released by the collector after parse.

param(
  [ValidateRange(30, 900)]
  [int]$StartupTimeoutSeconds = 300
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$cache = Join-Path $root ".local-cache"
$exe = Join-Path $cache "docling-venv\Scripts\docling-serve.exe"
$logDir = Join-Path $cache "docling"
$stdoutLog = Join-Path $logDir "serve.stdout.log"
$stderrLog = Join-Path $logDir "serve.stderr.log"

if (-not (Test-Path -LiteralPath $exe)) {
  throw "Docling is not installed at $exe"
}

try {
  $health = Invoke-WebRequest "http://127.0.0.1:5001/health" -TimeoutSec 3 -UseBasicParsing
  if ($health.StatusCode -eq 200) {
    "Docling already running: http://127.0.0.1:5001"
    exit 0
  }
} catch {
  # Expected when the optional service is stopped.
}

New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$env:HF_HOME = Join-Path $cache "hf"
$env:SSL_CERT_FILE = Join-Path $cache "corp-root-ca.pem"
$env:REQUESTS_CA_BUNDLE = $env:SSL_CERT_FILE
$env:DOCLING_SERVE_ENABLE_UI = "false"
$env:DOCLING_SERVE_LOAD_MODELS_AT_BOOT = "false"
$env:DOCLING_SERVE_MAX_SYNC_WAIT = "900"

$process = Start-Process -FilePath $exe `
  -ArgumentList @("run", "--host", "127.0.0.1", "--port", "5001") `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
do {
  Start-Sleep -Seconds 2
  try {
    $health = Invoke-WebRequest "http://127.0.0.1:5001/health" -TimeoutSec 2 -UseBasicParsing
  } catch {
    $health = $null
  }
} while (-not $health -and (Get-Date) -lt $deadline)

if (-not $health) {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id }
  "Docling failed to start within ${StartupTimeoutSeconds}s. See $stdoutLog and $stderrLog"
  exit 1
}

"Docling ready: http://127.0.0.1:5001 (pid=$($process.Id))"
