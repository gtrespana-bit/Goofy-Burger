#!/usr/bin/env python3
"""Punto de entrada: ``python vigia.py --host 0.0.0.0 --port 8000``."""

from __future__ import annotations

import argparse
import os
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# En PyInstaller con console=False, estos pueden ser None. Los reemplazamos
# por os.devnull antes de que uvicorn configure su logging.
_std_replacements = ()


def _safe_data_dir() -> Path:
    """Carpeta de datos estable, con un fallback sencillo si app.config fallase."""
    env = os.environ.get("VIGIA_DATA_DIR")
    if env:
        return Path(env).expanduser().resolve()
    try:
        from app import config as app_config  # noqa: E402

        return Path(app_config.default_data_dir()).resolve()
    except Exception:
        if os.name == "nt":
            root = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
            return (Path(root) / "Vigia").resolve()
        if sys.platform == "darwin":
            return (Path.home() / "Library" / "Application Support" / "Vigia").resolve()
        return (Path.home() / ".local" / "share" / "vigia").resolve()


def _prepare_std_streams() -> None:
    """Reemplaza stdout/stderr/stdin por os.devnull si son None."""
    global _std_replacements
    if _std_replacements:
        return
    args = {"encoding": "utf-8", "errors": "replace"}
    current: list = []
    for name, mode in (("stdin", "r"), ("stdout", "w"), ("stderr", "w")):
        stream = getattr(sys, name, None)
        if stream is None:
            stream = open(os.devnull, mode, **args)
            setattr(sys, name, stream)
        current.append(stream)
    _std_replacements = tuple(current)


def _log_startup_running() -> Path:
    """Deja constancia del arranque en data/logs/vigia-startup.log."""
    log_dir = _safe_data_dir() / "logs"
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        marker = log_dir / "vigia-startup.log"
        with marker.open("a", encoding="utf-8", errors="replace") as fh:
            fh.write(
                f"[{__import__('datetime').datetime.now():%Y-%m-%d %H:%M:%S}] "
                "Vigia iniciando...\n"
            )
        return marker
    except Exception:
        return Path()


def _report_unhandled_error() -> int:
    """Guardia de errores para el .exe sin consola.

    Aunque no haya consola, escribe el traceback en ``%APPDATA%\\Vigia\\logs``
    y, en Windows, muestra un diálogo con el resumen para que el fallo no sea
    invisible.
    """
    exc_text = traceback.format_exc()
    log_dir = _safe_data_dir() / "logs"
    log_path = log_dir / "startup_error.log"
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8", errors="replace") as fh:
            fh.write(
                f"[{__import__('datetime').datetime.now():%Y-%m-%d %H:%M:%S}]\n"
                f"{exc_text}\n"
            )
    except Exception:
        pass

    summary = "Vigia no ha podido arrancar.\n\nRevisa:\n" + str(log_path)
    try:
        import ctypes  # type: ignore

        ctypes.windll.user32.MessageBoxW(0, summary, "Vigia - error de arranque", 0x10)  # type: ignore
    except Exception:
        pass
    return 1


def _default_data_dir() -> str:
    """Carpeta de datos por defecto, igual que en app.config (aquí sin cargar
    la app para poder lanzar el navegador antes/después)."""
    return str(_safe_data_dir())


def _open_browser(url: str, delay: float = 1.5) -> None:
    """Abre el navegador unos instantes después de arrancar el servidor."""
    import threading
    import time
    import webbrowser

    def _open():
        time.sleep(delay)
        try:
            webbrowser.open(url)
        except Exception:
            pass

    threading.Thread(target=_open, daemon=True).start()


def _open_desktop_window(url: str) -> None:
    """Abre la interfaz en una ventana propia de escritorio (pywebview).

    En un `.exe` instalado esto evita saltar al navegador: la app se ve como
    una aplicación normal, dentro de su propia ventana.
    """
    import webview  # type: ignore

    webview.create_window(
        "Vigía",
        url,
        width=1280,
        height=820,
        min_size=(1000, 680),
        resizable=True,
        confirm_close=False,
        text_select=True,
    )
    webview.start()


def _run_main() -> None:
    parser = argparse.ArgumentParser(description="Vigía - videovigilancia casera")
    parser.add_argument("--host", default=os.environ.get("VIGIA_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("VIGIA_PORT", 8000)))
    parser.add_argument("--reload", action="store_true", help="Recarga automática (desarrollo)")
    parser.add_argument("--lan", action="store_true",
                        help="Escucha en 0.0.0.0 para acceder desde otros equipos")
    parser.add_argument("--data-dir", default=os.environ.get("VIGIA_DATA_DIR"),
                        help="Carpeta de datos (config + grabaciones). "
                             "Por defecto: carpeta de datos del usuario.")
    parser.add_argument("--no-browser", action="store_true",
                        help="No abrir ninguna ventana ni navegador al arrancar")
    parser.add_argument("--browser", action="store_true",
                        help="Usar el navegador en vez de la ventana propia (requiere pywebview)")
    parser.add_argument("--ssl-certfile", default="",
                        help="Certificado TLS/HTTPS (junto a --ssl-keyfile)")
    parser.add_argument("--ssl-keyfile", default="",
                        help="Clave privada TLS/HTTPS")
    args = parser.parse_args()

    if args.lan:
        args.host = "0.0.0.0"
    if args.data_dir:
        os.environ["VIGIA_DATA_DIR"] = args.data_dir
    else:
        # Asegura la carpeta de datos estable también para el ejecutable.
        os.environ.setdefault("VIGIA_DATA_DIR", _default_data_dir())

    # Importamos la app directamente en el ejecutable, en lugar de pasarle a
    # uvicorn la cadena "app.main:app". Así PyInstaller analiza y empaqueta
    # app.main de forma garantizada (con la cadena, la app dependía solo de
    # hiddenimports y el .exe instalado daba "No module named 'app.main'").
    from app.main import app as fastapi_app

    # HTTPS: puede venir por CLI o desde Ajustes → Acceso remoto.
    ssl_certfile = args.ssl_certfile
    ssl_keyfile = args.ssl_keyfile
    if not ssl_certfile:
        try:
            from app.config import config as vigia_config
            remote = vigia_config.data.get("general", {}).get("remote", {}) or {}
            ssl_certfile = remote.get("certfile", "") or ""
            ssl_keyfile = remote.get("keyfile", "") or ""
        except Exception:
            pass
    ssl_certfile = ssl_certfile.strip() or None
    ssl_keyfile = ssl_keyfile.strip() or None
    scheme = "https" if (ssl_certfile and ssl_keyfile) else "http"

    if args.reload:
        import uvicorn

        # `reload` requiere que uvicorn reciba la app como cadena; es sólo para
        # desarrollo, no para el .exe empaquetado.
        uvicorn.run(
            "app.main:app",
            host=args.host,
            port=args.port,
            reload=True,
            log_level="info",
            access_log=False,
            use_colors=False,
        )
        return

    # Sin reload: usamos uvicorn.Server para poder distinguir un arranque real
    # de un fallo silencioso (p. ej. puerto 8000 ocupado) en el .exe sin consola.
    import threading
    import time

    import uvicorn

    config = uvicorn.Config(
        fastapi_app,
        host=args.host,
        port=args.port,
        log_level="info",
        access_log=False,
        use_colors=False,
        ssl_certfile=ssl_certfile,
        ssl_keyfile=ssl_keyfile,
    )
    server = uvicorn.Server(config)
    thread_errors: list[str] = []

    def _server_run():
        try:
            server.run()
        except BaseException:
            thread_errors.append(traceback.format_exc())
            raise

    thread = threading.Thread(target=_server_run, daemon=True)
    thread.start()

    deadline = time.time() + 15
    while (time.time() < deadline
           and not server.started
           and not server.should_exit
           and thread.is_alive()):
        time.sleep(0.1)

    if not server.started:
        detail = (
            f"Servidor en {scheme}://{args.host}:{args.port}\n"
            "Posible causa: el puerto ya esta en uso o la inicio fallo.\n\n"
            "Si el puerto 8000 esta ocupado, cierra otro Vigia o lanzalo con:\n"
            "Vigia.exe --port 8001"
        )
        if thread_errors:
            detail += "\n\nDetalle del error:\n" + thread_errors[-1]
        raise RuntimeError(detail)

    url = f"{scheme}://127.0.0.1:{args.port}/"

    # Por defecto, la app se abre en su propia ventana de escritorio (pywebview).
    # Sólo usamos el navegador si se pide con --browser, con --no-browser, o si
    # pywebview no está instalado (p.ej. ejecutando desde código en Linux).
    window_used = False
    window_error = ""
    if not args.no_browser and not args.browser:
        try:
            _open_desktop_window(url)
            window_used = True
        except Exception as exc:
            window_error = f"{type(exc).__name__}: {exc}"

    if window_used:
        # La ventana se cerró: detener el servidor.
        server.should_exit = True
        thread.join(timeout=10)
        return

    if window_error:
        try:
            log_path = _safe_data_dir() / "logs" / "startup_error.log"
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with log_path.open("a", encoding="utf-8", errors="replace") as fh:
                fh.write(
                    f"[{__import__('datetime').datetime.now():%Y-%m-%d %H:%M:%S}] "
                    f"Ventana propia no disponible ({window_error}); se abre el navegador.\n"
                )
        except Exception:
            pass

    if not args.no_browser:
        _open_browser(url)

    thread.join()


def main() -> int:
    # Deja marca de arranque Y prepara los streams antes de crear la Config de
    # uvicorn. Si algo falla antes de llegar a uvicorn, lo capturamos y lo
    # guardamos/dialogamos en vez de cerrar la ventana en silencio.
    _log_startup_running()
    _prepare_std_streams()
    try:
        _run_main()
    except KeyboardInterrupt:
        return 0
    except SystemExit:
        raise
    except BaseException:
        return _report_unhandled_error()
    return 0


if __name__ == "__main__":
    sys.exit(main())
