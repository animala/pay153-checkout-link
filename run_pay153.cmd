@echo off
setlocal
cd /d "%~dp0"
if not exist "..\gpt_register_pay\.pay153-internal-key" powershell -NoProfile -Command "[guid]::NewGuid().ToString('N') | Set-Content -LiteralPath '..\gpt_register_pay\.pay153-internal-key' -Encoding ascii -NoNewline"
if not defined PAY153_INTERNAL_KEY if exist "..\gpt_register_pay\.pay153-internal-key" set /p PAY153_INTERNAL_KEY=<"..\gpt_register_pay\.pay153-internal-key"
if not defined PAY153_INTERNAL_KEY_FILE set "PAY153_INTERNAL_KEY_FILE=%CD%\..\gpt_register_pay\.pay153-internal-key"
set "PAY153_HOST=127.0.0.1"
set "PAY153_PORT=18082"
set "PAY153_BILLING_ADDRESS_CACHE=%CD%\data\billing_addresses.json"
set "PAY153_LOG_DIR=%CD%\logs"
set "PH_SHORT_CONTEXT_PATH=%CD%\data\ph_short_contexts.jsonl"
"%CD%\.venv\Scripts\python.exe" app.py >> pay153-runtime.log 2>&1
