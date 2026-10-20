@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   把小鲸鱼注册成「登录时自动启动」的计划任务。
echo   任务名：dsh-bot-whale
echo   要跑的命令：%~dp0start.cmd
echo.
echo   注意：这会在每次登录 Windows 时弹出一个控制台窗口（就是 start.cmd）。
echo   不想要了就跑 uninstall-autostart.cmd。
echo.
pause

set TASK_TR="%~dp0start.cmd"
schtasks /create /tn "dsh-bot-whale" /tr %TASK_TR% /sc onlogon /f

if errorlevel 1 (
  echo.
  echo   注册失败。可能原因：
  echo     1. 需要管理员权限 —— 右键这个文件，选「以管理员身份运行」；
  echo     2. 组策略/安全软件禁止创建计划任务。
  echo.
) else (
  echo.
  echo   好了。查一下：
  echo     schtasks /query /tn "dsh-bot-whale"
  echo   想立刻试跑一次：
  echo     schtasks /run /tn "dsh-bot-whale"
  echo.
)
pause
