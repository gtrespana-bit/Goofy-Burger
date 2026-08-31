#!/usr/bin/env python3
"""Punto de entrada: ``python vigia.py --host 0.0.0.0 --port 8000``."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def _default_data_dir() -> str:
    """Carpeta de datos por defecto, igual que en app.config (aquí sin cargar
    la app para poder lanzar el navegador antes/después)."""
    from app import config as app_config  # noqa: E402

    return str(app_config.default_data_dir())


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


def main() -> None:
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
                        help="No abrir el navegador automáticamente al arrancar")
    args = parser.parse_args()

    if args.lan:
        args.host = "0.0.0.0"
    if args.data_dir:
        os.environ["VIGIA_DATA_DIR"] = args.data_dir
    else:
        # Asegura la carpeta de datos estable también para el ejecutable.
        os.environ.setdefault("VIGIA_DATA_DIR", _default_data_dir())

    if not args.reload and not args.no_browser:
        _open_browser(f"http://127.0.0.1:{args.port}/")

    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info",
        access_log=False,
    )


if __name__ == "__main__":
    main()
