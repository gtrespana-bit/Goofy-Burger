@echo off
REM Compila Vigia como aplicacion de escritorio de Windows y genera el instalador.
REM
REM Requisitos (una sola vez):
REM   python -m venv .venv  &&  .venv\Scripts\activate
REM   pip install -r requirements.txt pyinstaller
REM   Inno Setup 6 (https://jrsoftware.org/isinfo.php)
REM
REM Inno Setup puede instalarse en la ruta por defecto; este script lo busca en
REM las ubicaciones habituales y en el PATH. Tambien puedes forzarlo con:
REM   set "ISCC_PATH=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
REM   build\build_windows.bat
REM
REM Uso:  build\build_windows.bat

setlocal EnableExtensions
cd /d "%~dp0\.."

set VERSION=1.0.1
set "ISCC_EXE="

REM Preparar variables con las rutas de instalacion (evita problemas con el
REM parentesis de "Program Files (x86)" dentro de bloques IF).
set "PF86="
if defined ProgramFiles(x86) set "PF86=%ProgramFiles(x86)%"
set "PF="
if defined ProgramFiles set "PF=%ProgramFiles%"
set "LA="
if defined LocalAppData set "LA=%LocalAppData%"

REM 1) Buscar ISCC.exe en el PATH.
for /f "delims=" %%I in ('where iscc.exe 2^>nul') do if not defined ISCC_EXE set "ISCC_EXE=%%I"

REM 2) Rutas forzadas por el usuario.
if not defined ISCC_EXE if defined ISCC_PATH if exist "%ISCC_PATH%" set "ISCC_EXE=%ISCC_PATH%"
if not defined ISCC_EXE if defined ISCC if exist "%ISCC%" set "ISCC_EXE=%ISCC%"

REM 3) Rutas por defecto de Inno Setup 6 y 7.
if not defined ISCC_EXE if defined PF86 if exist "%PF86%\Inno Setup 6\ISCC.exe" set "ISCC_EXE=%PF86%\Inno Setup 6\ISCC.exe"
if not defined ISCC_EXE if defined PF if exist "%PF%\Inno Setup 6\ISCC.exe" set "ISCC_EXE=%PF%\Inno Setup 6\ISCC.exe"
if not defined ISCC_EXE if defined PF86 if exist "%PF86%\Inno Setup 7\ISCC.exe" set "ISCC_EXE=%PF86%\Inno Setup 7\ISCC.exe"
if not defined ISCC_EXE if defined PF if exist "%PF%\Inno Setup 7\ISCC.exe" set "ISCC_EXE=%PF%\Inno Setup 7\ISCC.exe"
if not defined ISCC_EXE if defined LA if exist "%LA%\Programs\Inno Setup 6\ISCC.exe" set "ISCC_EXE=%LA%\Programs\Inno Setup 6\ISCC.exe"
if not defined ISCC_EXE if defined LA if exist "%LA%\Programs\Inno Setup 7\ISCC.exe" set "ISCC_EXE=%LA%\Programs\Inno Setup 7\ISCC.exe"

if defined ISCC_EXE (
    echo [0/4] Inno Setup encontrado: %ISCC_EXE%
) else (
    echo [0/4] AVISO: no se encontro ISCC.exe.
    echo.
    echo   Comprobadas las ubicaciones habituales de Inno Setup 6 y 7:
    echo     "%PF86%\Inno Setup 6\ISCC.exe"
    echo     "%PF%\Inno Setup 6\ISCC.exe"
    echo     "%PF86%\Inno Setup 7\ISCC.exe"
    echo     "%PF%\Inno Setup 7\ISCC.exe"
    echo     "%LA%\Programs\Inno Setup 6\ISCC.exe"
    echo     "%LA%\Programs\Inno Setup 7\ISCC.exe"
    echo     y el PATH (where iscc.exe)
    echo.
    echo   Soluciones:
    echo     1) Abre el Prompt de Inno Setup y ejecuta alli el script.
    echo        Inicio ^> Inno Setup 6 ^> Inno Setup Compiler.
    echo     2) Anade la carpeta de Inno Setup al PATH.
    echo     3) Fuerza la ruta:  set "ISCC_PATH=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
    echo        y vuelve a ejecutar  build\build_windows.bat
    echo.
    echo   El .exe portable se generara igualmente en dist\Vigia\Vigia.exe.
    echo.
)

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
    echo Revisa si hay python/pyinstaller instalados correctamente.
    goto :fin
)

if not defined ISCC_EXE (
    echo.
    echo [3/4] AVISO: Inno Setup no encontrado, no se genera el instalador.
    echo        La version portable ya esta lista: dist\Vigia\Vigia.exe
    goto :fin
)

echo [3/4] Generando instalador con Inno Setup...
"%ISCC_EXE%" /DMyAppVersion=%VERSION% "build\installer.iss"
if errorlevel 1 (
    echo ERROR: Inno Setup fallo. Revisa los mensajes anteriores.
    echo        La version portable ya esta lista: dist\Vigia\Vigia.exe
) else (
    echo [4/4] Listo: dist\Vigia-Setup-%VERSION%.exe
)

:fin

echo.
echo Terminado.
pause

endlocal
