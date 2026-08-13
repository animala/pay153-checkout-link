@echo off
setlocal
cd /d "%~dp0"
set "PAY153_HOST=127.0.0.1"
set "PAY153_PORT=18082"
set "PAY153_BILLING_ADDRESS_CACHE=%CD%\data\billing_addresses.json"
set "PAY153_LOG_DIR=%CD%\logs"
set "PH_SHORT_CONTEXT_PATH=%CD%\data\ph_short_contexts.jsonl"
"%CD%\.venv\Scripts\python.exe" app.py >> pay153-runtime.log 2>&1
