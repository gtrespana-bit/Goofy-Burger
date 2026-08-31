@echo off
REM Compila Vigia como aplicacion de escritorio de Windows y genera el instalador.
REM
REM Requisitos (una sola vez):
REM   python -m venv .venv  &&  .venv\Scripts\activate
REM   pip install -r requirements.txt pyinstaller
REM   (instalar Inno Setup 6 desde https://jrsoftware.org/isinfo.php
REM    y anadir ISCC.exe al PATH, o ajustar ISCC abajo)
REM
REM Uso:  build\build_windows.bat

setlocal
cd /d "%~dp0\.."

set VERSION=0.1.0
set ISCC=ISCC.exe

if not exist ".venv" (
    echo [1/4] Creando entorno virtual...
    python -m venv .venv
)
call .venv\Scripts\activate.bat

echo [1/4] Comprobando dependencias...
python -m pip install --upgrade pip >nul
python -m pip install -r requirements.txt
python -m pip install pyinstaller

echo [2/4] Empaquetando con PyInstaller...
pyinstaller --noconfirm --workpath build\_work --distpath dist build\vigia.spec
if errorlevel 1 (
    echo ERROR: PyInstaller fallo.
    exit /b 1
)

echo [3/4] Generando instalador con Inno Setup...
%ISCC% /DMyAppVersion=%VERSION% "build\installer.iss"
if errorlevel 1 (
    echo AVISO: no se encontro ISCC.exe. El .exe ya esta en dist\Vigia\Vigia.exe.
    echo Instala Inno Setup y vuelve a ejecutar este script para generar el instalador.
) else (
    echo [4/4] Listo: dist\Vigia-Setup-%VERSION%.exe
)

endlocal
