@echo off
rem Double-click launcher for start-lab.ps1, the local phone lab (README.md in this folder).
rem The pause keeps the window open after Mujeeb stops, so its last log lines stay readable.
powershell.exe -NoProfile -File "%~dp0start-lab.ps1" %*
pause
