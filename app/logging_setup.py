"""Logging a consola y a fichero rotado en data/logs/."""

from __future__ import annotations

import logging
import logging.handlers


from .config import DATA_DIR

CONFIGURED = False


def _is_noise_message(msg: str) -> bool:
    """¿Es un mensaje de ruido (corte de conexión al cerrar subprocesos)?"""
    n = (msg or "").lower()
    if not n:
        return False
    if "_proactorbasepipetransport._call_connection_lost" in n:
        return True
    if "connection reset" in n or "connectionreset" in n:
        return True
    if "winerror 10054" in n or "10054" in n:
        return True
    if "se ha forzado la interrupción" in n or "forzad" in n:
        return True
    return False


def _is_noise_exception(exc) -> bool:
    if exc is None:
        return False
    if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
        return True
    if isinstance(exc, OSError) and getattr(exc, "winerror", None) in (10054, 10053):
        return True
    return _is_noise_message(str(exc))


class _NoiseFilter(logging.Filter):
    """Oculta trazas de cierre de sockets/ffmpeg que no son fallos reales.

    Al cerrar Vigía (o al rotar/cortar un flujo de ffmpeg) Windows (Proactor)
    registra ``_ProactorBasePipeTransport._call_connection_lost()`` /
    ``ConnectionResetError [WinError 10054]``. No indican un problema del
    usuario, sólo que la conexión se cortó porque el subproceso terminó.

    IMPORTANTE: este filtro se adjunta a los **handlers**, no al logger raíz.
    Adjuntarlo al logger raíz no sirve: los registros de ``asyncio`` o de
    ``vigia.*`` se emiten a través de sus propios loggers y sólo pasan por los
    handlers, donde sí se aplica el filtro del handler.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:
            return True
        if _is_noise_message(msg):
            return False
        if record.exc_info:
            exc = record.exc_info[1]
            if _is_noise_exception(exc):
                return False
        return True


def _install_loop_noise_guard() -> None:
    """Silencia el ruido Proactor en el propio bucle de eventos (asyncio).

    Los ``ConnectionResetError [WinError 10054]`` se generan al cerrar pipes de
    subprocesos (ffmpeg). Con un handler propio los descartamos ANTES de que
    lleguen al logging, sin tocar el resto de errores reales.
    """
    try:
        import asyncio

        loop = asyncio.get_running_loop()
    except Exception:
        return
    try:
        previous = loop.get_exception_handler()
    except Exception:
        previous = None

    def _handler(loop, context):  # noqa: ANN001
        message = str(context.get("message", "") or "")
        if _is_noise_message(message) or _is_noise_exception(context.get("exception")):
            return  # ruido esperado: se descarta
        if previous is not None:
            previous(loop, context)
        else:
            loop.default_exception_handler(context)

    loop.set_exception_handler(_handler)


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
    noise_filter = _NoiseFilter()

    console = logging.StreamHandler()
    console.setFormatter(fmt)
    console.addFilter(noise_filter)
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
            handler.addFilter(noise_filter)
            root.addHandler(handler)
        except Exception:
            pass

    for noisy in ("uvicorn.access",):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    # Descarta el ruido de cierre de sockets en el propio bucle de asyncio
    # (Windows/Proactor) antes de que llegue al logging.
    _install_loop_noise_guard()
    CONFIGURED = True
