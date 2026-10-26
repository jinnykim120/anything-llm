# export-for-mac.ps1 - 이 윈도 PC 의 NEXUS 시스템을 "폴더 하나"로 묶어 맥으로 옮길 수 있게 만든다.
#
#   powershell -ExecutionPolicy Bypass -File scripts\export-for-mac.ps1 [-Out D:\NEXUS-Mac-Package] [-Force]
#                                                                       [-IncludeVectorCache]
#
# 결과 폴더(-Out):
#   app\      저장소 전체(커밋된 코드 + git 이력, LF 줄바꿈). node_modules 는 제외(맥에서 설치)
#   data\     config\(.env · 사내 CA) · storage\(SQLite · 문서 · 모델) · hf\(Docling 모델) · pg\(벡터 DB 덤프)
#   1-setup.sh · 2-start.sh · 3-verify.sh · README-맥에서-시작하기.md
#
# 이 PC 의 서비스는 멈추지 않는다 (SQLite 는 VACUUM INTO, Postgres 는 pg_dump 로 일관된 스냅샷).
# 사전조건: WSL 의 AutoDocu-Postgres 가 켜져 있을 것(검색 DB 덤프), 코드 변경이 모두 커밋돼 있을 것.
param(
  [string]$Out = "D:\NEXUS-Mac-Package",
  [switch]$Force,
  [switch]$IncludeVectorCache
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "  OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  !!  $m" -ForegroundColor Yellow }
function ToWsl($p) { $full = [IO.Path]::GetFullPath($p); $d = $full.Substring(0,1).ToLower(); "/mnt/$d" + ($full.Substring(2) -replace '\\','/') }

# --- 0) 사전 점검 -------------------------------------------------------------
Step "0. 사전 점검"
$dirty = git status --porcelain --untracked-files=no
if ($dirty) {
  Warn "커밋되지 않은 변경이 있습니다 — app\ 에는 커밋된 코드만 들어갑니다:"
  $dirty | ForEach-Object { Write-Host "       $_" }
  if (-not $Force) { throw "먼저 커밋하거나 -Force 로 무시하세요." }
}
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
$commit = (git rev-parse --short HEAD).Trim()
$originUrl = (git remote get-url origin).Trim()
Ok "브랜치 $branch @ $commit"

if (Test-Path $Out) {
  if ((Get-ChildItem $Out -Force | Measure-Object).Count -gt 0) {
    if (-not $Force) { throw "$Out 가 비어 있지 않습니다. -Force 로 덮어쓰기(기존 내용 삭제)하세요." }
    Remove-Item $Out -Recurse -Force
  }
}
New-Item -ItemType Directory -Force $Out, "$Out\data\config", "$Out\data\storage", "$Out\data\pg" | Out-Null
$Out = (Resolve-Path $Out).Path

# --- 1) 코드(app\) -----------------------------------------------------------------
Step "1. 코드 복제 (app\)"
git -c core.autocrlf=false -c core.eol=lf clone --no-hardlinks --quiet --branch $branch "$root" "$Out\app"
git -C "$Out\app" remote set-url origin $originUrl
Ok "app\ ← $branch @ $commit (origin = $originUrl)"

# --- 2) 설정 -----------------------------------------------------------------------
Step "2. 설정 파일 (비밀키 포함 — 폴더를 안전하게 보관하세요)"
Copy-Item "server\.env.development" "$Out\data\config\server.env.development"
Copy-Item "collector\.env.development" "$Out\data\config\collector.env.development"
if (Test-Path "frontend\.env") { Copy-Item "frontend\.env" "$Out\data\config\frontend.env" }
if (Test-Path ".local-cache\corp-root-ca.pem") { Copy-Item ".local-cache\corp-root-ca.pem" "$Out\data\config\corp-root-ca.pem"; Ok "사내 프록시 CA 포함" }
Ok "config\ 완료"

# --- 3) SQLite ---------------------------------------------------------------------
Step "3. SQLite DB 스냅샷 (VACUUM INTO)"
$sqlite = node scripts\mac\export-sqlite.cjs "$Out\data\storage\anythingllm.db"
if ($LASTEXITCODE -ne 0) { throw "SQLite 내보내기 실패: $sqlite" }
$sqlite | ForEach-Object { Write-Host "       $_" }
$sqliteInfo = @{}; $sqlite | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { $sqliteInfo[$Matches[1]] = $Matches[2] } }

# --- 4) storage 복사 -----------------------------------------------------------------
Step "4. server\storage 복사 (문서 · 모델 · 플러그인)"
$copy = @('documents','models','plugins','assets','comkey','usage-log','generated-files','push-notifications')
if ($IncludeVectorCache) { $copy += 'vector-cache' }
foreach ($d in $copy) {
  $src = "server\storage\$d"
  if (-not (Test-Path $src)) { continue }
  robocopy $src "$Out\data\storage\$d" /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy 실패: $d (코드 $LASTEXITCODE)" }
  $sz = [math]::Round((Get-ChildItem "$Out\data\storage\$d" -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB)
  Ok ("{0,-18} {1,6} MB" -f $d, $sz)
}
if (Test-Path "server\storage\README.md") { Copy-Item "server\storage\README.md" "$Out\data\storage\README.md" }
$global:LASTEXITCODE = 0

# --- 5) Docling 모델 캐시 -----------------------------------------------------------
Step "5. Docling 모델 캐시 (맥에서 다시 내려받지 않도록)"
if (Test-Path ".local-cache\hf") {
  robocopy ".local-cache\hf" "$Out\data\hf" /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy 실패: hf" }
  $global:LASTEXITCODE = 0
  Ok ("hf  {0} MB" -f [math]::Round((Get-ChildItem "$Out\data\hf" -Recurse -File -Force | Measure-Object Length -Sum).Sum / 1MB))
} else { Warn ".local-cache\hf 없음 — 맥에서 첫 사용 때 모델을 내려받습니다" }

# --- 6) pgvector 덤프 ----------------------------------------------------------------
Step "6. pgvector 벡터 DB 덤프 (WSL Postgres → gzip)"
$conn = node scripts\mac\parse-pg-url.cjs "server\.env.development"
$pg = @{}; $conn | ForEach-Object { if ($_ -match "^(\w+)='(.*)'$") { $pg[$Matches[1]] = $Matches[2].Replace("'\''","'") } }
$dumpWin = "$Out\data\pg\anythingllm_vectors.sql.gz"
$dumpWsl = ToWsl $dumpWin
$pw = $pg['PGPW'].Replace("'", "'\''")
wsl -d AutoDocu-Postgres -- bash -c "set -o pipefail; PGPASSWORD='$pw' pg_dump -h 127.0.0.1 -U $($pg['PGU']) --no-owner --no-privileges $($pg['PGDB_']) | gzip > '$dumpWsl'"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $dumpWin)) { throw "pg_dump 실패 (WSL AutoDocu-Postgres 가 켜져 있는지 확인)" }
$rows = (wsl -d AutoDocu-Postgres -- bash -c "PGPASSWORD='$pw' psql -h 127.0.0.1 -U $($pg['PGU']) -d $($pg['PGDB_']) -Atc 'select count(*) from anythingllm_vectors'").Trim()
Ok ("덤프 {0:N1} MB, 벡터 {1}행" -f ((Get-Item $dumpWin).Length / 1MB), $rows)

# --- 7) 맥용 시작 파일 -----------------------------------------------------------------
Step "7. 시작 파일 · 안내서"
Copy-Item "scripts\mac\package-root\*" $Out -Recurse -Force
Ok "1-setup.sh / 2-start.sh / 3-verify.sh / README"

# --- 8) MANIFEST -----------------------------------------------------------------------
Step "8. MANIFEST"
$docCount = (Get-ChildItem "$Out\data\storage\documents" -Recurse -File -Force | Measure-Object).Count
$manifest = @(
  "NEXUS Mac package",
  "created=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
  "source_host=$env:COMPUTERNAME",
  "git_branch=$branch",
  "git_commit=$commit",
  "node_on_source=$((node -v).Trim())",
  "llm_model=$((Select-String -Path server\.env.development -Pattern '^CLAUDE_CLI_MODEL=' | Select-Object -First 1).Line)",
  "pgvector_rows=$rows",
  "sqlite_workspace_documents=$($sqliteInfo['rows_workspace_documents'])",
  "sqlite_classifications=$($sqliteInfo['rows_document_classifications'])",
  "storage_documents_files=$docCount",
  "sha256_sqlite=$((Get-FileHash "$Out\data\storage\anythingllm.db" -Algorithm SHA256).Hash)",
  "sha256_pgdump=$((Get-FileHash $dumpWin -Algorithm SHA256).Hash)"
)
Set-Content -Path "$Out\data\MANIFEST.txt" -Value $manifest -Encoding UTF8
$manifest | ForEach-Object { Write-Host "       $_" }

$total = [math]::Round((Get-ChildItem $Out -Recurse -File -Force | Measure-Object Length -Sum).Sum / 1GB, 2)
Write-Host "`n완료: $Out  (총 $total GB)" -ForegroundColor Green
Write-Host "맥으로 폴더째 복사한 뒤  bash 1-setup.sh  를 실행하세요. 자세한 순서는 README-맥에서-시작하기.md"
