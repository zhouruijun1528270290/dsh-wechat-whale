@echo off
rem 小鲸鱼 · 桥接进程（供 Windows 计划任务调用，不依赖任何终端窗口）
chcp 65001 >nul
cd /d "%~dp0"
echo. >> "%~dp0logs\run-bridge.out.txt"
echo ===== %date% %time% 启动 ===== >> "%~dp0logs\run-bridge.out.txt"
node "%~dp0src\bridge.mjs" >> "%~dp0logs\run-bridge.out.txt" 2>> "%~dp0logs\run-bridge.err.txt"
echo ===== %date% %time% 退出（%ERRORLEVEL%）===== >> "%~dp0logs\run-bridge.out.txt"
