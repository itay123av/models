@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Starting automata server...
start "automata-server" cmd /k node server.js
timeout /t 2 /nobreak >nul
start "" "http://localhost:8790/automata.html"
