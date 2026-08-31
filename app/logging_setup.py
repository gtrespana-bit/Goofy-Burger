"""Logging a consola y a fichero rotado en data/logs/."""

from __future__ import annotations

import logging
import logging.handlers


from .config import DATA_DIR

CONFIGURED = False


def get_logger(name: str) -> logging.Logger:
    """Logger usable antes de que se configure el logging raíz."""
    return logging.getLogger(name)


def setup(level: int = logging.INFO, log_to_file: bool = True) -> None:
    global CONFIGURED
    if CONFIGURED:
        return
    root = logging.getLogger()
    root.setLevel(level)
    fmt = logging.Formatter(
        "%(asctime)s %(levelname)-7s [%(name)s] %(message)s", "%Y-%m-%d %H:%M:%S"
    )

    console = logging.StreamHandler()
    console.setFormatter(fmt)
    root.addHandler(console)

    if log_to_file:
        try:
            log_dir = DATA_DIR / "logs"
            log_dir.mkdir(parents=True, exist_ok=True)
            handler = logging.handlers.RotatingFileHandler(
                log_dir / "vigia.log", maxBytes=2 * 1024 * 1024, backupCount=3,
                encoding="utf-8",
            )
            handler.setFormatter(fmt)
            root.addHandler(handler)
        except Exception:
            pass

    for noisy in ("uvicorn.access",):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    CONFIGURED = True
