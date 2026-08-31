# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec para empaquetar Vigía como aplicación de escritorio.
# Genera un .exe autocontenido (carpeta dist\Vigia) con Python, ONVIF (zeep),
# ffmpeg (imageio-ffmpeg), la interfaz web y los datos fuera del ejecutable.
#
# Uso:
#   pip install pyinstaller
#   pyinstaller --noconfirm build/vigia.spec
#
# El .exe guarda la configuración y grabaciones en la carpeta de datos del
# usuario del SO (p. ej. %APPDATA%\Vigia), así que sobreviven a actualizaciones.

import os

from PyInstaller.utils.hooks import collect_submodules

# `SPECPATH` lo define PyInstaller (ruta de la carpeta donde está el .spec),
# porque dentro de un spec `__file__` no existe.
ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))

# Todos los módulos de la app (vigia.py arranca con uvicorn.run("app.main:app"),
# que es una cadena, así que hay que declararlos explícitamente).
hiddenimports = []
hiddenimports += collect_submodules("app")
hiddenimports += collect_submodules("onvif")
hiddenimports += collect_submodules("zeep")
# zeep/lxml a veces necesitan estos ocultos en entornos Windows
hiddenimports += [
    "lxml", "lxml.etree", "lxml._elementpath", "lxml.objectify",
    "requests", "requests.auth", "requests.sessions", "requests.models",
    "requests.packages.urllib3",
]

a = Analysis(
    [os.path.join(ROOT, "vigia.py")],
    pathex=[ROOT],
    binaries=[],
    datas=[
        (os.path.join(ROOT, "web"), "web"),
        (os.path.join(ROOT, "samples"), "samples"),
        (os.path.join(ROOT, "build", "icon.png"), "."),
    ],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "ultralytics",      # opcional; muy pesado. Instálalo aparte si quieres IA.
        "matplotlib",
        "tkinter",
        "PyQt5", "PyQt6", "PySide2", "PySide6",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Vigia",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,          # sin ventana de consola: aplicación de escritorio
    disable_windowed_traceback=False,
    icon=os.path.join(ROOT, "build", "vigia.ico"),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="Vigia",
)
