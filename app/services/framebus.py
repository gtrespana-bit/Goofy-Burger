"""Bus de frames en memoria.

Cada cámara publica su último frame codificado en JPEG; los visores (MJPEG)
y los endpoints de snapshot lo consumen sin abrir una segunda conexión a la
cámara. Con 6 visores mirando la misma cámara seguimos usando un único stream.
"""

from __future__ import annotations

import threading
import time
from typing import Dict, Optional

import cv2
import numpy as np


class FrameSlot:
    def __init__(self) -> None:
        self.cond = threading.Condition()
        self.jpeg: Optional[bytes] = None
        self.frame: Optional[np.ndarray] = None
        self.ts: float = 0.0
        self.counter: int = 0
        self.width = 0
        self.height = 0

    def publish(self, frame: np.ndarray, jpeg: Optional[bytes] = None, quality: int = 78) -> bytes:
        if jpeg is None:
            ok, buf = cv2.imencode(
                ".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)]
            )
            jpeg = buf.tobytes() if ok else None
        if jpeg is None:
            return b""
        h, w = frame.shape[:2]
        with self.cond:
            self.jpeg = jpeg
            self.frame = frame
            self.ts = time.time()
            self.width, self.height = w, h
            self.counter += 1
            self.cond.notify_all()
        return jpeg

    def get(self, timeout: float = 3.0):
        """Devuelve (counter, jpeg) esperando un frame nuevo."""
        with self.cond:
            if self.jpeg is None:
                self.cond.wait(timeout=timeout)
            if self.jpeg is None:
                return None
            return self.counter, self.jpeg

    def latest(self):
        with self.cond:
            if self.jpeg is None:
                return None
            return self.counter, self.jpeg

    @property
    def age(self) -> float:
        with self.cond:
            return 0.0 if not self.ts else time.time() - self.ts


class FrameBus:
    def __init__(self) -> None:
        self._slots: Dict[str, FrameSlot] = {}
        self._lock = threading.Lock()

    def slot(self, camera_id: str) -> FrameSlot:
        with self._lock:
            slot = self._slots.get(camera_id)
            if slot is None:
                slot = FrameSlot()
                self._slots[camera_id] = slot
            return slot

    def publish(self, camera_id: str, frame: np.ndarray, jpeg: bytes = None, quality: int = 78):
        return self.slot(camera_id).publish(frame, jpeg, quality)

    def latest(self, camera_id: str):
        return self.slot(camera_id).latest()

    def drop(self, camera_id: str) -> None:
        with self._lock:
            self._slots.pop(camera_id, None)


frame_bus = FrameBus()
