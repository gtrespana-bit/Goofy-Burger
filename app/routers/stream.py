"""Directo (MJPEG) y snapshots."""

from __future__ import annotations

import time

import cv2
from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import StreamingResponse

from ..media import placeholder_jpeg
from ..services.framebus import frame_bus
from ..services.manager import manager
from ..config import config

router = APIRouter(prefix="/stream", tags=["stream"])

_NO_SIGNAL = None


def no_signal_jpeg() -> bytes:
    global _NO_SIGNAL
    if _NO_SIGNAL is None:
        _NO_SIGNAL = placeholder_jpeg("Sin señal")
    return _NO_SIGNAL


@router.get("/{camera_id}/live.mjpg")
def live_mjpeg(camera_id: str, fps: int = 12):
    """Stream MJPEG multipart. Funciona en cualquier navegador sin plugins."""
    max_fps = max(1, min(30, fps))
    interval = 1.0 / max_fps
    slot = frame_bus.slot(camera_id)

    def gen():
        last_counter = -1
        last_sent = 0.0
        # Un frame inicial para que el <img> no aparezca roto
        current = slot.latest()
        payload = current[1] if current else no_signal_jpeg()
        yield _frame(payload)
        while True:
            now = time.time()
            item = slot.get(timeout=2.0)
            if item is None:
                if now - last_sent > 2.0:
                    last_sent = now
                    yield _frame(no_signal_jpeg())
                continue
            counter, jpeg = item
            if counter == last_counter:
                if now - last_sent > 2.0:
                    last_sent = now
                    yield _frame(jpeg)
                continue
            if now - last_sent < interval:
                continue
            last_counter = counter
            last_sent = now
            yield _frame(jpeg)

    def _frame(jpeg: bytes) -> bytes:
        return (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n"
            b"Content-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n" + jpeg + b"\r\n"
        )

    return StreamingResponse(
        gen(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


@router.get("/{camera_id}/snapshot.jpg")
def snapshot(camera_id: str, force: bool = False):
    """Último frame conocido, o uno nuevo si no hay ninguno (force=true)."""
    if not config.get_camera(camera_id):
        raise HTTPException(404, "Cámara no encontrada")
    frame = None
    if not force:
        worker = manager.worker(camera_id)
        if worker is not None:
            frame = worker.snapshot_now()
    if frame is None:
        frame = manager.snapshot(camera_id)
    if frame is None:
        return Response(content=no_signal_jpeg(), media_type="image/jpeg")
    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
    if not ok:
        raise HTTPException(500, "No se pudo codificar la imagen")
    return Response(
        content=buf.tobytes(),
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/{camera_id}/status")
def stream_status(camera_id: str):
    slot = frame_bus.slot(camera_id)
    return {
        "camera_id": camera_id,
        "has_frame": slot.latest() is not None,
        "frame_age": round(slot.age, 2),
        "resolution": f"{slot.width}x{slot.height}",
        "health": manager.status(camera_id),
    }
