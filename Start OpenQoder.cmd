@echo off
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Install Python 3.9 or newer and add it to PATH.
  pause
  exit /b 1
)
python server.py --open
if errorlevel 1 pause
