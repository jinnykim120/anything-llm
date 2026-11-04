# 매일 08:00·14:00 에 risk.cmd 를 실행하는 작업 스케줄러 항목 두 개를 등록한다(현재 로그인한 사용자 권한, 비밀번호 저장 없음).
# 해제: Unregister-ScheduledTask NEXUS-Risk-AM, NEXUS-Risk-PM -Confirm:$false
$cmd = Join-Path $PSScriptRoot "risk.cmd"
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$cmd`""
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
foreach ($t in @(@("NEXUS-Risk-AM","08:00"), @("NEXUS-Risk-PM","14:00"))) {
  Register-ScheduledTask -TaskName $t[0] -Action $action -Trigger (New-ScheduledTaskTrigger -Daily -At $t[1]) -Settings $settings -Description "NEXUS Risk Monitor 이슈 수집·분석($($t[1]))" -Force | Out-Null
}
Get-ScheduledTask -TaskName "NEXUS-Risk-*" | Get-ScheduledTaskInfo | Select-Object TaskName, NextRunTime
