# Risk Monitor 서버를 로그인할 때 자동으로 켜는 작업 스케줄러 항목(NEXUS-Risk-Server)을 등록한다.
# - 현재 로그인한 사용자 권한으로 실행(비밀번호 저장 없음, 관리자 권한 불필요). 서버가 죽으면 1분 간격으로 3번 다시 켠다.
# - 이 스크립트가 있는 폴더 기준이라 다른 PC 로 폴더를 옮긴 뒤 한 번만 실행하면 된다:  powershell -ExecutionPolicy Bypass -File deploy\register-server-task.ps1
# - 해제: Unregister-ScheduledTask -TaskName NEXUS-Risk-Server -Confirm:$false
$cmd = Join-Path $PSScriptRoot "server.cmd"
if (-not (Test-Path $cmd)) { throw "server.cmd 를 찾을 수 없습니다: $cmd" }
$arg = "-NoProfile -WindowStyle Hidden -Command `"Start-Process -WindowStyle Hidden -FilePath cmd.exe -ArgumentList '/c','\`"$cmd\`"'`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "NEXUS-Risk-Server" -Action $action -Trigger $trigger -Settings $settings -Description "NEXUS Risk Monitor 서버(8081) 자동 시작" -Force | Out-Null
Get-ScheduledTask -TaskName "NEXUS-Risk-Server" | Select-Object TaskName, State | Format-Table -AutoSize
