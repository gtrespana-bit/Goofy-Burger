@echo off
REM Arranca Vigía en Windows. Doble clic o:  start.bat --lan
cd /d "%~dp0"

if not exist ".venv" (
    echo Creando entorno virtual...
    python -m venv .venv
)

call .venv\Scripts\activate.bat

python -c "import fastapi, uvicorn, cv2, requests" >nul 2>&1
if errorlevel 1 (
    echo Instalando dependencias...
    python -m pip install --upgrade pip
    python -m pip install -r requirements.txt
)

where ffmpeg >nul 2>&1
if errorlevel 1 (
    echo ffmpeg no esta en el PATH. Instalando la version de pip...
    python -m pip install imageio-ffmpeg
    echo AVISO: para mejor rendimiento instala ffmpeg y anadelo al PATH.
)

set HOST=127.0.0.1
if "%1"=="--lan" set HOST=0.0.0.0

echo.
echo   Vigia escuchando en http://%HOST%:8000
echo   (Ctrl+C para detener)
echo.
python vigia.py --host %HOST% --port 8000
pause
