"""Servicio de ficheros multimedia con soporte de rangos HTTP.

Los rangos son imprescindibles para poder mover la barra de un MP4 en el
navegador en lugar de esperar a que se descargue entero.
"""

from __future__ import annotations

import mimetypes

from pathlib import Path
from typing import Optional

from fastapi import HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from .config import DATA_DIR


def safe_media_path(relative: str) -> Path:
    """Resuelve una ruta relativa al directorio de datos, sin escapar de él."""
    rel = (relative or "").lstrip("/\\")
    candidate = (DATA_DIR / rel).resolve()
    root = DATA_DIR.resolve()
    if candidate != root and root not in candidate.parents:
        raise HTTPException(status_code=400, detail="Ruta no permitida")
    return candidate


def _chunks(path: Path, start: int, end: Optional[int], chunk_size: int = 1024 * 512):
    with path.open("rb") as fh:
        fh.seek(start)
        remaining = (end - start + 1) if end is not None else None
        while True:
            if remaining is not None and remaining <= 0:
                break
            size = min(chunk_size, remaining) if remaining is not None else chunk_size
            data = fh.read(size)
            if not data:
                break
            if remaining is not None:
                remaining -= len(data)
            yield data


def range_file_response(path: Path, request: Request, download: bool = False) -> Response:
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Fichero no encontrado")
    file_size = path.stat().st_size
    content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    range_header = request.headers.get("range")

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": content_type,
    }
    if download:
        headers["Content-Disposition"] = f'attachment; filename="{path.name}"'

    if not range_header or not range_header.startswith("bytes="):
        headers["Content-Length"] = str(file_size)
        return StreamingResponse(
            _chunks(path, 0, None), status_code=200, headers=headers, media_type=content_type
        )

    try:
        spec = range_header.split("=", 1)[1].split(",")[0].strip()
        start_s, _, end_s = spec.partition("-")
        start = int(start_s) if start_s else 0
        end = int(end_s) if end_s else file_size - 1
    except Exception:
        start, end = 0, file_size - 1
    if start >= file_size:
        raise HTTPException(
            status_code=416,
            detail="Rango fuera de límites",
            headers={"Content-Range": f"bytes */{file_size}"},
        )
    end = min(end, file_size - 1)
    length = end - start + 1
    headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
    headers["Content-Length"] = str(length)
    return StreamingResponse(
        _chunks(path, start, end),
        status_code=206,
        headers=headers,
        media_type=content_type,
    )


def placeholder_jpeg(text: str = "Sin señal", width: int = 640, height: int = 360) -> bytes:
    """Imagen JPEG generada al vuelo para cuando la cámara no responde."""
    import cv2
    import numpy as np

    img = np.full((height, width, 3), 24, dtype=np.uint8)
    cv2.putText(
        img, text, (int(width * 0.1), height // 2), cv2.FONT_HERSHEY_SIMPLEX,
        0.9, (90, 90, 90), 2, cv2.LINE_AA,
    )
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 60])
    return buf.tobytes() if ok else b""
