# install-autostart.ps1 - 윈도우에서 "로그인 시 자동 시작 + 5분마다 복구" 작업(NEXUS-AutoStart)을 만든다.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1            # 설치
#   ... -Pause     일시 정지 (서비스를 직접 내리고 작업할 때)
#   ... -Resume    다시 켜기
#   ... -Status    상태
#   ... -Remove    삭제
# 작업은 run-local.ps1 을 실행하며, 이미 떠 있는 서비스는 건너뛴다. 로그오프/재부팅 중에는
# 멈추고, 다음 로그인 때 다시 올라온다. 관리자 권한은 필요 없다(현재 사용자, 대화형).
param([switch]$Pause, [switch]$Resume, [switch]$Status, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$name = 'NEXUS-AutoStart'

if ($Status) {
  $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($t) { "$name : $($t.State)" } else { "$name : 설치되지 않음" }
  return
}
if ($Pause) { Disable-ScheduledTask -TaskName $name | Out-Null; "일시 정지: $name (다시 켜기: -Resume)"; return }
if ($Resume) { Enable-ScheduledTask -TaskName $name | Out-Null; "다시 켬: $name"; return }
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; "삭제됨: $name"; return }

$user = "$env:USERDOMAIN\$env:USERNAME"
# 창이 깜빡이지 않도록 conhost --headless 로 실행
$arg = "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$root\run-local.ps1`""
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument $arg -WorkingDirectory $root
$t1 = New-ScheduledTaskTrigger -AtLogOn -User $user
$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($t1, $t2) -Settings $settings -Principal $principal -Description 'NEXUS: 로그인 시 + 5분마다 run-local.ps1 실행(이미 떠 있는 서비스는 건너뜀)' -Force | Out-Null
"설치됨: $name  (로그인 시 + 5분마다 run-local.ps1)"
"일시 정지: install-autostart.ps1 -Pause   |   삭제: -Remove"
"참고: 절전 방지는 별도 설정입니다 — 전원 옵션에서 '전원 연결 시 절전 안 함', '덮개 닫을 때 아무것도 안 함'."
