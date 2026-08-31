@echo off
REM Vigia - modo web de desarrollo (sin .exe, sin ventana de escritorio).
REM
REM Uso:
REM   .venv\Scripts\activate.bat
REM   build\run_dev_web.bat
REM
REM Abre la interfaz en el navegador normal en http://127.0.0.1:8001
REM para poder ver los errores con F12 (Console / Network).

setlocal EnableExtensions
cd /d "%~dp0\.."

if not exist ".venv" (
  echo [1/2] Creando entorno virtual de desarrollo...
  python -m venv .venv || goto :error
)

call .venv\Scripts\activate.bat

echo [1/2] Comprobando dependencias...
python -m pip install --disable-pip-version-check --quiet --upgrade pip
python -m pip install --disable-pip-version-check --quiet -r requirements.txt
if errorlevel 1 goto :error

echo [2/2] Arrancando Vigia en el navegador (Ctrl+C para parar)...
echo.
echo   URL:            http://127.0.0.1:8001/
echo   Diagnostico:    http://127.0.0.1:8001/__vigia_debug
echo.
echo   Abre F12 -> Console y recarga con Ctrl+Shift+R.
echo.
python vigia.py --browser --port 8001 --data-dir .\devdata

goto :fin

:error
echo ERROR: no se pudo arrancar. Revisa la consola.
exit /b 1

:fin
endlocal
