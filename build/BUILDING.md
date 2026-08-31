# Empaquetado de Vigía como aplicación de escritorio

Vigía es (en su forma normal) un servidor web local (`http://127.0.0.1:8000`).
Para que se sienta como un **programa de ordenador de verdad**, se puede
empaquetar en un **.exe autocontenido** y en un **instalador de Windows**.

## Qué incluye el .exe

- Python + todas las dependencias (FastAPI, OpenCV…)
- **ONVIF (`onvif-zeep`)** para detectar todas las lentes y controlar el PTZ
- **ffmpeg (`imageio-ffmpeg`)** para grabar sin instalar nada más
- La interfaz web y el icono

## Dónde se guardan los datos (importante)

La configuración, grabaciones, clips y eventos se guardan **fuera del
ejecutable**, en la carpeta de datos del usuario del SO:

| Sistema | Carpeta |
|---|---|
| Windows | `%APPDATA%\Vigia` |
| macOS | `~/Library/Application Support/Vigia` |
| Linux | `~/.local/share/vigia` (o `$XDG_DATA_HOME/vigia`) |

Por eso, al **actualizar** o incluso al **desinstalar/reinstalar**, toda tu
información se conserva. Puedes forzar otra carpeta con la variable
`VIGIA_DATA_DIR` (el instalador la configura por ti en `%APPDATA%\Vigia`).

> Si se ejecuta desde el código fuente y ya existía una carpeta `data/` junto
> al código, Vigía la sigue usando (para no perder lo que ya tenías).

## Cómo generar el .exe y el instalador (Windows)

Instala las herramientas (una sola vez):

```bat
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt pyinstaller
```

Descarga e instala [Inno Setup 6](https://jrsoftware.org/isinfo.php) y deja
`ISCC.exe` accesible (añádelo al PATH).

Compila todo de una vez:

```bat
build\build_windows.bat
```

Resultado:

- `dist\Vigia\Vigia.exe` — la aplicación sin instalar (carpeta portátil)
- `dist\Vigia-Setup-0.1.0.exe` — el instalador

El instalador:
- instala el programa en `%LOCALAPPDATA%\Programs\Vigia`,
- crea accesos directos (escritorio + menú inicio),
- opcionalmente lo arranca con Windows,
- **no borra** `%APPDATA%\Vigia` al desinstalar.

## macOS / Linux

Puedes usar PyInstaller igualmente (`pyinstaller --noconfirm build/vigia.spec`
y adaptar `console=False`), o simplemente distribuir `start.sh`/`start.bat`,
que instalan dependencias automáticamente y abren el navegador.

## En marcha

Al arrancar, Vigía abre el navegador en `http://127.0.0.1:8000` automáticamente
(usa `--no-browser` para evitarlo).
