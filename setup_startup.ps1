$WshShell = New-Object -ComObject WScript.Shell
$StartupFolder = [Environment]::GetFolderPath('Startup')
$ShortcutPath = Join-Path $StartupFolder "BotResi.lnk"
$TargetBat = "c:\Users\Lenovo\Desktop\yusuf\Bot-resi\start_bot.bat"
$WorkingDir = "c:\Users\Lenovo\Desktop\yusuf\Bot-resi"

$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $TargetBat
$Shortcut.WorkingDirectory = $WorkingDir
$Shortcut.Description = "Auto Start Bot Resi Telegram Antigravity"
$Shortcut.Save()

Write-Output "SHORTCUT_CREATED: $ShortcutPath"
Write-Output "EXISTS: $(Test-Path $ShortcutPath)"
$check = $WshShell.CreateShortcut($ShortcutPath)
Write-Output "TARGET: $($check.TargetPath)"
Write-Output "WORKING_DIR: $($check.WorkingDirectory)"
