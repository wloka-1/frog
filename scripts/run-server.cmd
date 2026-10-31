@echo off
rem Windows entrypoint: keeps the frog server running, restarting it if it exits.
cd /d "%~dp0.."
if not exist "%USERPROFILE%\.frog" mkdir "%USERPROFILE%\.frog"
:loop
node server\index.js >> "%USERPROFILE%\.frog\server.log" 2>&1
timeout /t 3 /nobreak >nul
goto loop
