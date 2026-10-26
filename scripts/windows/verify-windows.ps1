# verify-windows.ps1 - 다른 윈도우 PC 에서 세팅이 제대로 됐는지 점검한다 (읽기 전용).
#   powershell -ExecutionPolicy Bypass -File scripts\windows\verify-windows.ps1 [-Llm]
#   -Llm : claude 에 짧은 질문 1회(사용량 극소)
param([switch]$Llm)
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$cache = Join-Path $root '.local-cache'
$script:pass = 0; $script:fail = 0; $script:warn = 0
function Pass($m) { Write-Host "  PASS $m" -ForegroundColor Green; $script:pass++ }
function Fail($m) { Write-Host "  FAIL $m" -ForegroundColor Red; $script:fail++ }
function Note($m) { Write-Host "  WARN $m" -ForegroundColor Yellow; $script:warn++ }
function Test-Cmd($n) { [bool](Get-Command $n -ErrorAction SilentlyContinue) }
function Http-Ok($u) { try { $r = Invoke-WebRequest -UseBasicParsing $u -TimeoutSec 5; return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400) } catch { return $false } }
$wsl = "$env:WINDIR\System32\wsl.exe"

Write-Host "[도구]"
if (Test-Cmd node) { Pass "node $(node -v)" } else { Fail "node 없음" }
if (Test-Cmd yarn) { Pass "yarn $(yarn -v)" } else { Fail "yarn 없음" }
foreach ($d in 'server', 'collector', 'frontend') { if (Test-Path "$root\$d\node_modules") { Pass "$d\node_modules" } else { Fail "$d\node_modules 없음 (yarn install)" } }
$py = "$cache\docling-venv\Scripts\python.exe"
if (Test-Path $py) {
  & $py -c "import docling, sklearn, statsmodels" 2>$null
  if ($LASTEXITCODE -eq 0) { Pass "Docling 파이썬 환경 (docling · sklearn · statsmodels)" } else { Fail "Docling 파이썬 모듈 import 실패" }
} else { Fail "Docling 가상환경 없음 (setup-windows.ps1)" }
if (Test-Path "$cache\docling-venv\Scripts\hwp5odt.exe") { Pass "hwp5odt (HWP 변환)" } else { Note "hwp5odt 없음 — HWP 렌더 변환 불가(텍스트 추출은 가능)" }
$lo = @("$env:ProgramFiles\LibreOffice\program\soffice.com", "${env:ProgramFiles(x86)}\LibreOffice\program\soffice.com", 'D:\LibreOffice\program\soffice.com') | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($lo) { Pass "LibreOffice" } else { Note "LibreOffice 없음 — PPT→PDF 변환 불가" }

Write-Host "[Claude]"
if (Test-Cmd claude) {
  Pass "claude CLI: $((Get-Command claude).Source)"
  $model = 'claude-sonnet-5-5'
  $line = Select-String -Path "$root\server\.env.development" -Pattern '^CLAUDE_CLI_MODEL=' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($line) { $model = ($line.Line -replace "^CLAUDE_CLI_MODEL=['""]?", '' -replace "['""].*$", '') }
  Write-Host "       모델 설정: $model"
  if ($Llm) {
    $out = (& claude -p --model $model "한 단어로만 답해: 안녕" 2>&1 | Select-Object -First 2) -join ' '
    if ($out) { Pass "claude 응답: $out" } else { Fail "claude 응답 없음 (터미널에서 claude 로 로그인했는지 확인)" }
  } else { Write-Host "       (실제 응답 시험은 -Llm)" }
} else { Fail "claude CLI 없음 — npm install -g @anthropic-ai/claude-code 후 claude 로 로그인" }

Write-Host "[WSL / pgvector]"
$names = @(& $wsl -l -q 2>$null | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
if ($names -contains 'AutoDocu-Postgres') { Pass "WSL 배포판 AutoDocu-Postgres 등록됨" } else { Fail "WSL 배포판 없음 (setup-windows.ps1)" }
if (Test-Path "$cache\wsl\AutoDocu-Postgres\ext4.vhdx") { Pass "ext4.vhdx 위치 (run-local.ps1 이 찾는 곳)" } else { Fail "$cache\wsl\AutoDocu-Postgres\ext4.vhdx 없음 — run-local.ps1 이 pgvector 를 건너뜁니다" }
& $wsl -d AutoDocu-Postgres -- pg_isready -h 127.0.0.1 -p 5432 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  Pass "Postgres 응답"
  try {
    $conn = & node "$root\scripts\mac\parse-pg-url.cjs" "$root\server\.env.development"
    $pg = @{}; $conn | ForEach-Object { if ($_ -match "^(\w+)='(.*)'$") { $pg[$Matches[1]] = $Matches[2].Replace("'\''", "'") } }
    $pw = $pg['PGPW'].Replace("'", "'\''")
    $n = (& $wsl -d AutoDocu-Postgres -- bash -c "PGPASSWORD='$pw' psql -h 127.0.0.1 -U $($pg['PGU']) -d $($pg['PGDB_']) -Atc 'select count(*) from anythingllm_vectors'" 2>$null | Out-String).Trim()
    if ($n -match '^\d+$') {
      Pass "앱 계정으로 접속 OK — 벡터 ${n}행"
      $mf = Join-Path (Split-Path -Parent $root) 'data\MANIFEST.txt'
      if (Test-Path $mf) { $want = (Select-String -Path $mf -Encoding UTF8 -Pattern '^pgvector_rows=' | Select-Object -First 1).Line -replace '^pgvector_rows=', ''; Write-Host "       내보낼 때: ${want}행" }
    } else { Fail "앱 계정으로 벡터 테이블을 읽지 못함" }
  } catch { Fail "벡터 행 수 확인 실패: $($_.Exception.Message)" }
} else { Fail "Postgres 꺼짐 — run-local.ps1 이 WSL 을 깨웁니다" }

Write-Host "[데이터]"
if (Test-Path "$root\server\storage\anythingllm.db") { Pass ("SQLite DB {0:N0} MB" -f ((Get-Item "$root\server\storage\anythingllm.db").Length / 1MB)) } else { Fail "server\storage\anythingllm.db 없음" }
if (Test-Path "$root\server\storage\documents") { Pass "문서 폴더" } else { Fail "문서 폴더 없음" }
if (Test-Path "$root\server\storage\models") { Pass "임베딩/리랭커 모델 폴더" } else { Note "모델 폴더 없음 — 첫 사용 때 다운로드(사내 프록시면 실패할 수 있음)" }
if ((Test-Path "$root\server\node_modules") -and (Test-Path "$root\scripts\mac\migrate-docpaths.cjs")) {
  $o = & node "$root\scripts\mac\migrate-docpaths.cjs" --check 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0) { Pass ("문서 경로 → 파일 확인: " + (($o -split "`n" | Where-Object { $_ -match '파일 확인' } | Select-Object -First 1)).Trim()) } else { Fail "일부 문서 파일을 찾지 못함 — $(($o -split "`n" | Where-Object { $_ -match '누락|파일 확인' } | Select-Object -First 3) -join ' ')" }
}

Write-Host "[서비스]"
if (Http-Ok 'http://localhost:3001/api/ping') { Pass "server :3001" } else { Fail "server :3001 응답 없음 (run-local.ps1)" }
if (Http-Ok 'http://localhost:8888/health') { Pass "collector :8888" } else { Fail "collector :8888 응답 없음" }
if (Http-Ok 'http://localhost:3000/') { Pass "frontend :3000" } else { Note "frontend :3000 응답 없음 — 시작 직후엔 30초쯤 걸릴 수 있음" }
if (Http-Ok 'http://127.0.0.1:5001/health') { Pass "Docling 켜짐" } else { Write-Host "       Docling 꺼짐 (정상: 필요할 때 화면의 켜기 버튼 또는 start-docling.ps1)" }

$freeGb = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 1)
Write-Host "[메모리]`n       여유 메모리 ${freeGb}GB (Docling 을 켜려면 2GB 이상 권장)"
Write-Host ("`n결과: PASS {0} · WARN {1} · FAIL {2}" -f $script:pass, $script:warn, $script:fail)
if ($script:fail -gt 0) { exit 1 }
