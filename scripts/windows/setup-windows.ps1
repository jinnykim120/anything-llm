# setup-windows.ps1 - 다른 윈도우 PC 에서 NEXUS 시스템을 처음 세팅한다 (설치 → 데이터 가져오기 → 실행).
#
#   powershell -ExecutionPolicy Bypass -File scripts\windows\setup-windows.ps1 [-Data DIR]
#       [-SkipInstall] [-SkipPython] [-SkipData] [-ForceData] [-NoStart]
#
# 하는 일 (모두 멱등 — 중간에 끊겨도 다시 실행하면 이어서 진행):
#   1 도구 설치      Node.js LTS · Python 3.12 · Git · LibreOffice (winget)
#   2 WSL + Postgres 내보낸 WSL 배포판(AutoDocu-Postgres, pgvector 포함)을 그대로 가져와 시작
#   3 데이터         설정(.env) · SQLite DB · 문서 · 모델 · Docling 캐시
#   4 Node 의존성    yarn install (server · collector · frontend) + prisma generate
#   5 Python 환경    .local-cache\docling-venv (Docling · 통계분석 · 한글 변환)
#   6 실행           run-local.ps1  →  http://localhost:3000/
#
# Windows PowerShell 5.1 에서도 동작하도록 작성했다(PowerShell 7 불필요).
# 관리자 권한은 WSL 기능을 새로 켜야 할 때만 필요하다.
param(
  [string]$Data,
  [switch]$SkipInstall,
  [switch]$SkipPython,
  [switch]$SkipData,
  [switch]$ForceData,
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$cache = Join-Path $root '.local-cache'
if (-not $Data) { $Data = Join-Path (Split-Path -Parent $root) 'data' }
New-Item -ItemType Directory -Force $cache | Out-Null

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "  OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  !!  $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "  xx  $m" -ForegroundColor Red; exit 1 }
function Test-Cmd($n) { [bool](Get-Command $n -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $u = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$m;$u"
}
function Wsl-Names {
  # wsl -l -q 는 UTF-16 + NUL 문자로 나온다
  $o = & "$env:WINDIR\System32\wsl.exe" -l -q 2>$null
  @($o | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
}

Write-Host "NEXUS 윈도우 세팅" -ForegroundColor White
Write-Host "  저장소 : $root"
Write-Host "  데이터 : $Data"

# --- 0) 사전 점검 -------------------------------------------------------------
Step "0. 환경 점검"
$os = [Environment]::OSVersion.Version
if ($os.Major -lt 10 -or $os.Build -lt 19041) { Die "Windows 10 2004(빌드 19041) 이상이 필요합니다 (WSL2). 현재: $($os)" }
Ok "Windows $($os)"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) { Ok "관리자 권한" } else { Warn "관리자 권한이 아닙니다 — WSL 을 새로 켜야 하면 관리자 PowerShell 에서 다시 실행하세요" }
$free = [math]::Round((Get-PSDrive -Name ($root.Substring(0, 1))).Free / 1GB, 1)
Ok "여유 디스크 ${free}GB (권장 20GB 이상)"
if (Test-Path "$Data\MANIFEST.txt") { Get-Content "$Data\MANIFEST.txt" | Select-Object -First 8 | ForEach-Object { Write-Host "       $_" } }

# 사내 프록시 CA 를 먼저 적용해 winget/yarn/pip 가 통하게
$ca = Join-Path $cache 'corp-root-ca.pem'
if ((-not (Test-Path $ca)) -and (Test-Path "$Data\config\corp-root-ca.pem")) { Copy-Item "$Data\config\corp-root-ca.pem" $ca }
if (Test-Path $ca) {
  $env:NODE_EXTRA_CA_CERTS = $ca; $env:SSL_CERT_FILE = $ca; $env:REQUESTS_CA_BUNDLE = $ca; $env:PIP_CERT = $ca
  Ok "사내 프록시 CA 적용"
}
# run-local.ps1 과 같은 캐시 위치(설치물이 저장소 폴더 안에 모이게)
$env:YARN_CACHE_FOLDER = Join-Path $cache 'yarn'
$env:npm_config_cache = Join-Path $cache 'npm'
$env:npm_config_devdir = Join-Path $cache 'node-gyp'
$env:npm_config_strict_ssl = 'false'
$env:PUPPETEER_CACHE_DIR = Join-Path $cache 'puppeteer'

# --- 1) 도구 설치 -------------------------------------------------------------
if (-not $SkipInstall) {
  Step "1. 도구 설치 (winget)"
  $haveNode = (Test-Cmd node) -and ((node -v) -match '^v(\d+)' -and [int]$Matches[1] -ge 18)
  $havePy = $false
  if (Test-Cmd py) { & py -3.12 --version 2>$null | Out-Null; $havePy = ($LASTEXITCODE -eq 0) }
  $haveGit = Test-Cmd git
  $lo = @("$env:ProgramFiles\LibreOffice\program\soffice.com", "${env:ProgramFiles(x86)}\LibreOffice\program\soffice.com", 'D:\LibreOffice\program\soffice.com') | Where-Object { Test-Path $_ } | Select-Object -First 1
  $need = @()
  if (-not $haveNode) { $need += 'OpenJS.NodeJS.LTS' }
  if (-not $havePy) { $need += 'Python.Python.3.12' }
  if (-not $haveGit) { $need += 'Git.Git' }
  if (-not $lo) { $need += 'TheDocumentFoundation.LibreOffice' }
  if ($need.Count -gt 0 -and -not (Test-Cmd winget)) {
    Die "winget 이 없습니다. 다음을 직접 설치한 뒤 다시 실행하세요: $($need -join ', ')  (Microsoft Store 의 '앱 설치 관리자' 업데이트로 winget 을 받을 수 있습니다)"
  }
  foreach ($id in $need) {
    Write-Host "  설치: $id"
    & winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { Warn "$id 설치가 0 이 아닌 코드($LASTEXITCODE)로 끝났습니다 — 이미 설치돼 있으면 무시해도 됩니다" }
  }
  Refresh-Path
  if ($haveNode) { Ok "node $(node -v) (이미 설치됨)" }
  if ($havePy) { Ok "Python 3.12 (이미 설치됨)" }
  if ($haveGit) { Ok "git (이미 설치됨)" }
  if ($lo) { Ok "LibreOffice (이미 설치됨)" }
}
Refresh-Path
if (-not (Test-Cmd node)) { Die "node 를 찾지 못했습니다. 새 PowerShell 창을 열어 다시 실행하거나 Node.js 를 설치하세요" }
$nodeMajor = [int]((node -v) -replace '^v(\d+).*', '$1')
if ($nodeMajor -ne 24) { Warn "Node $(node -v) — 원본 PC 는 v24 에서 검증했습니다. 다른 버전은 미검증입니다" } else { Ok "node $(node -v)" }
if (-not (Test-Cmd yarn)) { Write-Host "  설치: yarn (npm i -g yarn)"; npm install -g yarn; Refresh-Path }
Ok "yarn $(yarn -v)"

# --- 2) WSL + Postgres(pgvector) --------------------------------------------------
Step "2. WSL + pgvector Postgres"
$distro = 'AutoDocu-Postgres'
$wsl = "$env:WINDIR\System32\wsl.exe"
$wslOk = $false
if (Test-Path $wsl) { & $wsl --status 2>$null | Out-Null; $wslOk = ($LASTEXITCODE -eq 0) }
if (-not $wslOk) {
  if (-not $isAdmin) { Die "WSL 이 켜져 있지 않습니다. 관리자 PowerShell 에서 이 스크립트를 다시 실행하세요 (WSL 기능을 켭니다)" }
  Write-Host "  WSL 기능 설치 중..."
  & $wsl --install --no-distribution
  Die "WSL 을 설치했습니다. **PC 를 재부팅**한 뒤 이 스크립트를 다시 실행하세요."
}
Ok "WSL 사용 가능"
$names = Wsl-Names
$distroDir = Join-Path $cache "wsl\$distro"
if ($names -contains $distro) {
  Ok "배포판 $distro 이미 등록됨"
} else {
  $tar = Join-Path $Data 'wsl\AutoDocu-Postgres.tar'
  if (-not (Test-Path $tar)) { Die "WSL 배포판 파일($tar)이 없습니다. 패키지가 불완전합니다 (벡터 덤프 data\pg 로 수동 복원은 README 참고)" }
  New-Item -ItemType Directory -Force $distroDir | Out-Null
  Write-Host "  배포판 가져오는 중 (약 3GB, 몇 분 걸립니다)..."
  & $wsl --import $distro $distroDir $tar --version 2
  if ($LASTEXITCODE -ne 0) { Die "wsl --import 실패 (코드 $LASTEXITCODE)" }
  Ok "배포판 가져옴 → $distroDir"
}
if (-not (Test-Path (Join-Path $distroDir 'ext4.vhdx'))) { Warn "run-local.ps1 은 $distroDir\ext4.vhdx 를 찾습니다 — 다른 위치에 등록돼 있으면 pgvector 시작을 건너뜁니다" }
Write-Host "  Postgres 시작..."
& $wsl -d $distro -- systemctl start postgresql
$pgUp = $false
for ($i = 0; $i -lt 40; $i++) {
  & $wsl -d $distro -- pg_isready -h 127.0.0.1 -p 5432 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $pgUp = $true; break }
  Start-Sleep 2
}
if (-not $pgUp) { Die "Postgres 가 응답하지 않습니다 (wsl -d $distro -- systemctl status postgresql 로 확인)" }
Ok "Postgres 응답"

# --- 3) 데이터 가져오기 ---------------------------------------------------------------
if (-not $SkipData) {
  Step "3. 데이터 가져오기"
  if (-not (Test-Path $Data)) { Warn "데이터 폴더($Data)가 없어 건너뜁니다" } else {
    function Copy-Cfg($src, $dst) {
      if (-not (Test-Path $src)) { return }
      if ((Test-Path $dst) -and -not $ForceData) { Write-Host "  유지: $dst (이미 있음)"; return }
      New-Item -ItemType Directory -Force (Split-Path -Parent $dst) | Out-Null
      Copy-Item $src $dst -Force
      Write-Host "  복사: $dst"
    }
    Copy-Cfg "$Data\config\server.env.development" "$root\server\.env.development"
    Copy-Cfg "$Data\config\collector.env.development" "$root\collector\.env.development"
    Copy-Cfg "$Data\config\frontend.env" "$root\frontend\.env"
    Copy-Cfg "$Data\config\corp-root-ca.pem" $ca

    $stor = Join-Path $root 'server\storage'
    if ((Test-Path "$stor\anythingllm.db") -and -not $ForceData) {
      Write-Host "  server\storage 에 이미 DB 가 있어 건너뜁니다 (-ForceData 로 덮어쓰기)"
    } else {
      if (Test-Path "$stor\anythingllm.db") { Copy-Item "$stor\anythingllm.db" "$stor\anythingllm.db.bak.$(Get-Date -Format yyyyMMddHHmmss)" }
      Write-Host "  server\storage 복사 중 (문서·모델 약 4.5GB)..."
      robocopy "$Data\storage" $stor /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
      if ($LASTEXITCODE -ge 8) { Die "robocopy 실패 (코드 $LASTEXITCODE)" }
      $global:LASTEXITCODE = 0
      Ok "server\storage 완료"
    }
    if (Test-Path "$Data\hf") {
      if ((Test-Path "$cache\hf") -and -not $ForceData) { Write-Host "  Docling 모델 캐시 유지" } else {
        robocopy "$Data\hf" "$cache\hf" /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
        if ($LASTEXITCODE -ge 8) { Die "robocopy 실패 (hf)" }
        $global:LASTEXITCODE = 0
        Ok "Docling 모델 캐시 완료"
      }
    }
  }
}

# --- 4) Node 의존성 --------------------------------------------------------------------
Step "4. Node 의존성 (처음에는 5~10분 걸립니다)"
foreach ($d in @('server', 'collector', 'frontend')) {
  Write-Host "  yarn install: $d"
  Push-Location (Join-Path $root $d)
  try {
    yarn install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { yarn install; if ($LASTEXITCODE -ne 0) { Die "yarn install 실패: $d" } }
  } finally { Pop-Location }
}
Push-Location (Join-Path $root 'server')
try { npx prisma generate; if ($LASTEXITCODE -ne 0) { Die "prisma generate 실패" } } finally { Pop-Location }
Ok "Node 의존성 준비됨"

# --- 5) Python (Docling · 통계분석 · 한글 변환) ----------------------------------------------
if (-not $SkipPython) {
  Step "5. Python 환경 (Docling 등, 처음에는 5~15분 걸립니다)"
  $venv = Join-Path $cache 'docling-venv'
  if (-not (Test-Path "$venv\Scripts\python.exe")) {
    & py -3.12 -m venv $venv
    if ($LASTEXITCODE -ne 0) { Die "Python 3.12 가상환경 생성 실패 (py -3.12 가 설치돼 있는지 확인)" }
  }
  & "$venv\Scripts\python.exe" -m pip install --upgrade pip | Out-Null
  & "$venv\Scripts\python.exe" -m pip install -r "$root\scripts\windows\requirements-win.txt"
  if ($LASTEXITCODE -ne 0) {
    Warn "고정 버전 설치에 실패해 버전 제한 없는 목록으로 다시 시도합니다"
    & "$venv\Scripts\python.exe" -m pip install -r "$root\scripts\windows\requirements-win.loose.txt"
    if ($LASTEXITCODE -ne 0) { Die "Python 패키지 설치 실패" }
  }
  & "$venv\Scripts\python.exe" -c "import docling, sklearn, statsmodels, pandas, openpyxl, docx; print('  python modules OK')"
  if (Test-Path "$venv\Scripts\docling-serve.exe") { Ok "docling-serve 설치됨" } else { Warn "docling-serve.exe 가 없습니다" }
}

# --- 6) 외부 도구 점검 ------------------------------------------------------------------------
Step "6. 외부 도구 점검"
if (Test-Cmd claude) { Ok "claude CLI: $((Get-Command claude).Source)" } else {
  Warn "claude CLI 가 없습니다. 답변·보고서 생성에 필요합니다:`n       npm install -g @anthropic-ai/claude-code   후 터미널에서  claude  를 한 번 실행해 로그인하세요."
}

# --- 7) 실행 ------------------------------------------------------------------------------------
if (-not $NoStart) {
  Step "7. 서비스 시작"
  & "$root\run-local.ps1"
  Write-Host "`n완료.  http://localhost:3000/  을 열어 보세요." -ForegroundColor Green
  Write-Host "   점검:  powershell -ExecutionPolicy Bypass -File scripts\windows\verify-windows.ps1"
  Write-Host "   자동 시작(로그인 시 + 5분마다 복구):  powershell -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1"
}
