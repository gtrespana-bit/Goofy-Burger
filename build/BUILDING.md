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

Descarga e instala [Inno Setup 6](https://jrsoftware.org/isinfo.php). El
script `build_windows.bat` busca `ISCC.exe` en el PATH y en las rutas
habituales de Inno Setup 6 y 7, así que no hace falta añadirlo manualmente al
PATH. El instalador usa `x64compatible` si el compilador es 6.3+ (o 7) y
`x64` con versiones anteriores, así que compila en cualquiera de ellas.

Si lo instalaste en una ruta personalizada, indícala antes de compilar:

```bat
set "ISCC_PATH=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
build\build_windows.bat
```

Otra opción es abrir el *Inno Setup Compiler* desde el menú inicio y ejecutar
ahí el script.

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

## Solución de problemas

- **"No se encontró ISCC.exe de Inno Setup 6 en el PATH"** — el script ya
  detecta automáticamente las rutas por defecto de Inno Setup 6 y 7. Si
  todavía no lo encuentra, usa `set "ISCC_PATH=..."` como se indica más
  arriba. Puedes comprobar la ruta con:
  `dir "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"`.
- **`Vigia.exe` no arranca con `'NoneType' object has no attribute 'isatty'`
  / `Unable to configure formatter 'default'`** — ocurre por ejecutar uvicorn
  dentro de un `.exe` sin consola (`console=False`), donde Windows deja
  `stdout/stderr` a `None`. El punto de entrada ahora redirige esos flujos a
  `os.devnull` y apaga los colores de uvicorn, así que la app arranca sin
  ventana de consola y guarda sus logs en `%APPDATA%\Vigia\logs\vigia.log`.
  Es necesario **volver a compilar** el `.exe` con el código corregido.
- **Al hacer doble clic en `Vigia.exe` no se ve nada** — si el `.exe` es una
  aplicación sin consola, un fallo de arranque parecía no mostrar nada. Ahora
  el arranque deja una marca en
  `%APPDATA%\Vigia\logs\vigia-startup.log` y cualquier excepción se guarda en
  `%APPDATA%\Vigia\logs\startup_error.log` además de mostrar un aviso en
  Windows. Si el puerto 8000 está ocupado, el aviso indica que puedes cerrar
  la otra instancia o lanzar `Vigia.exe --port 8001`.

## macOS / Linux

Puedes usar PyInstaller igualmente (`pyinstaller --noconfirm build/vigia.spec`
y adaptar `console=False`), o simplemente distribuir `start.sh`/`start.bat`,
que instalan dependencias automáticamente y abren el navegador.

## En marcha

Al arrancar, Vigía abre el navegador en `http://127.0.0.1:8000` automáticamente
(usa `--no-browser` para evitarlo).
