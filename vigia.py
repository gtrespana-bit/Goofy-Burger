#!/usr/bin/env python3
"""Punto de entrada: ``python vigia.py --host 0.0.0.0 --port 8000``."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def main() -> None:
    parser = argparse.ArgumentParser(description="Vigía - videovigilancia casera")
    parser.add_argument("--host", default=os.environ.get("VIGIA_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("VIGIA_PORT", 8000)))
    parser.add_argument("--reload", action="store_true", help="Recarga automática (desarrollo)")
    parser.add_argument("--lan", action="store_true",
                        help="Escucha en 0.0.0.0 para acceder desde otros equipos")
    parser.add_argument("--data-dir", default=os.environ.get("VIGIA_DATA_DIR"))
    args = parser.parse_args()

    if args.lan:
        args.host = "0.0.0.0"
    if args.data_dir:
        os.environ["VIGIA_DATA_DIR"] = args.data_dir

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
