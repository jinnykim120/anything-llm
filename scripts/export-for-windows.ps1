# export-for-windows.ps1 - 다른 윈도우 PC 로 옮길 패키지(폴더 하나)를 만든다.
#
#   powershell -ExecutionPolicy Bypass -File scripts\export-for-windows.ps1 [-Out D:\NEXUS-Windows-Package] [-Force]
#
# export-for-mac.ps1 -Target windows 의 얇은 래퍼다. 결과 폴더에는 맥 패키지의 내용(app · data)에
# 더해 pgvector Postgres 가 든 WSL 배포판(data\wsl)과 윈도우용 설치 스크립트가 들어간다.
# 서비스(서버 3001)가 내려가 있어야 한다 — 배포판을 내보내려면 Postgres 를 잠깐 멈춘다.
param(
  [string]$Out = "D:\NEXUS-Windows-Package",
  [switch]$Force,
  [switch]$IncludeVectorCache
)
$args2 = @{ Out = $Out; Target = 'windows' }
if ($Force) { $args2.Force = $true }
if ($IncludeVectorCache) { $args2.IncludeVectorCache = $true }
& "$PSScriptRoot\export-for-mac.ps1" @args2
