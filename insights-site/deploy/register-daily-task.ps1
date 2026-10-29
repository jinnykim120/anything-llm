# 매일 오전 10시에 daily.cmd 를 실행하는 작업 스케줄러 항목을 등록한다(현재 로그인한 사용자 권한, 비밀번호 저장 없음).
# PC 가 10시에 꺼져 있었다면 켜진 뒤 바로 실행한다(StartWhenAvailable). 해제: Unregister-ScheduledTask NEXUS-Insight-Daily -Confirm:$false
$cmd = Join-Path $PSScriptRoot "daily.cmd"
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$cmd`""
$trigger = New-ScheduledTaskTrigger -Daily -At 10:00
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "NEXUS-Insight-Daily" -Action $action -Trigger $trigger -Settings $settings -Description "NEXUS Insight 오늘의 이슈 카드 자동 생성·전송" -Force | Out-Null
Get-ScheduledTask -TaskName "NEXUS-Insight-Daily" | Get-ScheduledTaskInfo | Select-Object NextRunTime, LastTaskResult
