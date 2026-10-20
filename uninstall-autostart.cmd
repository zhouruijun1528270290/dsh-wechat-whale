@echo off
chcp 65001 >nul
echo.
echo   取消开机自启（删掉计划任务 dsh-bot-whale）……
schtasks /delete /tn "dsh-bot-whale" /f
echo.
echo   如果提示「找不到」，说明本来就没注册。
pause
