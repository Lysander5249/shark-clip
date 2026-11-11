@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
set NODE_OPTIONS=
set NODE_PATH=
set NODE_EXTRA_CA_CERTS=
set CLIP_FETCHER_PORT=
set CLIP_FETCHER_OUTPUT_DIR=
set CLIP_FETCHER_DATA_DIR=
set CLIP_FETCHER_PARENT_PID=
"%~dp0app\bin\node.exe" "%~dp0app\desktop\main.mjs" --browser
if errorlevel 1 (
  echo.
  echo The local service stopped. Please re-extract the complete package and try again.
  pause
)
endlocal
