@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 小鲸鱼 · 微信机器人（守护中）

echo.
echo   小鲸鱼 · 微信机器人
echo   ────────────────────────────────────────────────
echo   管理台地址会在下面打印出来（带 token，只给本机浏览器用）
echo   退出码 42 = 配置更新，自动重载；窗口别关，关了机器人就下线
echo   停止 = 直接关掉这个窗口，或者在管理台点「停止机器人」
echo.

:loop
node "%~dp0src\bridge.mjs"
set CODE=%ERRORLEVEL%

if "%CODE%"=="0"  goto stopped
if "%CODE%"=="42" goto reload
if "%CODE%"=="3"  goto already

echo.
echo   [守护] 意外退出（退出码 %CODE%），3 秒后自动重启……（要彻底停就关掉这个窗口）
timeout /t 3 /nobreak >nul
goto loop

:reload
echo.
echo   [守护] 配置已更新，2 秒后重载……
timeout /t 2 /nobreak >nul
goto loop

:already
echo.
echo   [守护] 已经有一个小鲸鱼在跑了（单实例锁）。要换新的，先关掉那个窗口。
pause
goto :eof

:stopped
echo.
echo   小鲸鱼已经下班了。
pause
