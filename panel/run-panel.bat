@echo off
rem Start the DSH desktop card manually (useful for debugging without DSH).
rem
rem The plugin normally launches the card automatically when DSH starts.
rem This file is the fallback: double-click it to open just the card.
rem
rem Data lives in %USERPROFILE%\.dsh\desktop-card\ by default.
rem If the plugin is running, it passes DSH_CARD_DATA_DIR; here we let
rem Panel.ps1 use its own default (the same folder).

powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0Panel.ps1"
