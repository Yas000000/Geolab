@echo off
rem Starts the Outreach Helper for the portal's "Re-check blocked pages" button.
rem Leave this window open while you re-check; close it when you're done.
title Outreach Helper
cd /d "%~dp0.."
python helper\outreach_helper.py
if errorlevel 1 (
  echo.
  echo The helper stopped. It needs Python with playwright and beautifulsoup4:
  echo   python -m pip install playwright beautifulsoup4
  echo and Google Chrome installed.
  pause
)
