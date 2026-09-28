@echo off
cd /d "%~dp0"
call npm install
echo Starting Plune_call server...
start "" powershell -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:3000'"
npm start
