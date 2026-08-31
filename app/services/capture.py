"""Fuentes de vídeo: RTSP, USB, fichero y una cámara sintética de demo.

Todas exponen la misma interfaz mínima (``open`` / ``read`` / ``release``)
para que el worker de cámara sea agnóstico al origen.
"""

from __future__ import annotations

import platform
import subprocess
import time
from abc import ABC, abstractmethod

from typing import List, Optional, Tuple

import cv2
import numpy as np

from ..models import with_credentials

IS_WIN = platform.system() == "Windows"
IS_MAC = platform.system() == "Darwin"


def _usb_backend() -> int:
    if IS_WIN:
        return cv2.CAP_DSHOW
    if IS_MAC:
        return cv2.CAP_AVFOUNDATION
    return cv2.CAP_V4L2


class Source(ABC):
    """Interfaz común de todas las fuentes de vídeo."""

    label: str = "source"

    def __init__(self, camera: dict):
        self.camera = camera

    @abstractmethod
    def open(self) -> bool: ...

    @abstractmethod
    def read(self) -> Tuple[bool, Optional[np.ndarray]]: ...

    def release(self) -> None:  # pragma: no cover - trivial
        pass

    @property
    def record_url(self) -> str:
        """URL/ruta que debe usar ffmpeg para grabar (si aplica)."""
        return ""

    @property
    def ffmpeg_input_args(self) -> List[str]:
        """Argumentos de entrada para ffmpeg (si aplica)."""
        return []


class Cv2Source(Source):
    """Base para fuentes leídas con cv2.VideoCapture."""

    def __init__(self, camera: dict):
        super().__init__(camera)
        self.cap: Optional[cv2.VideoCapture] = None
        self._target: Optional[str] = None

    def _build_target(self):  # pragma: no cover - override
        raise NotImplementedError

    def open(self) -> bool:
        target = self._build_target()
        if target is None:
            return False
        self.release()
        self.cap = cv2.VideoCapture(target)
        if not self.cap.isOpened():
            # Segundo intento sin backend específico
            self.cap = cv2.VideoCapture(target if not isinstance(target, str) else target)
        if self.cap is not None and self.cap.isOpened():
            # Algunos backends ignoran el buffer; 1 frame de buffer = más fresco
            try:
                self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            except Exception:
                pass
            return True
        self.cap = None
        return False

    def read(self):
        if self.cap is None:
            return False, None
        ok, frame = self.cap.read()
        return ok, frame

    def release(self):
        if self.cap is not None:
            try:
                self.cap.release()
            except Exception:
                pass
            self.cap = None


class RtspSource(Cv2Source):
    label = "rtsp"

    def _build_target(self):
        cam = self.camera
        url = cam.get("substream_url") or cam.get("url") or ""
        if not url:
            return None
        url = with_credentials(url, cam.get("username", ""), cam.get("password", ""))
        return url

    @property
    def record_url(self) -> str:
        cam = self.camera
        return with_credentials(cam.get("url") or "", cam.get("username", ""), cam.get("password", ""))

    @property
    def ffmpeg_input_args(self) -> List[str]:
        return ["-rtsp_transport", "tcp", "-i", self.record_url]


class UsbSource(Cv2Source):
    label = "usb"

    def _build_target(self):
        cam = self.camera
        if IS_WIN and cam.get("device_name"):
            return f"video={cam['device_name']}"
        index = int(cam.get("device_index", 0) or 0)
        return index

    def open(self) -> bool:
        target = self._build_target()
        self.release()
        attempts = [(_usb_backend(), target)]
        if isinstance(target, str):  # dshow con nombre de dispositivo
            attempts = [(cv2.CAP_DSHOW, target)]
        else:
            attempts = [(_usb_backend(), target), (cv2.CAP_ANY, target)]
        for backend, tgt in attempts:
            try:
                cap = cv2.VideoCapture(tgt, backend)
            except Exception:
                continue
            if cap is not None and cap.isOpened():
                try:
                    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                except Exception:
                    pass
                self.cap = cap
                return True
            if cap is not None:
                cap.release()
        self.cap = None
        return False

    @property
    def ffmpeg_input_args(self) -> List[str]:
        cam = self.camera
        if IS_WIN:
            dev = cam.get("device_name") or str(cam.get("device_index", 0))
            return ["-f", "dshow", "-i", f"video={dev}"]
        if IS_MAC:
            dev = cam.get("device_name") or str(cam.get("device_index", 0))
            return ["-f", "avfoundation", "-i", dev]
        return ["-f", "v4l2", "-i", f"/dev/video{int(cam.get('device_index', 0) or 0)}"]


class FileSource(Cv2Source):
    """Reproduce un fichero de vídeo en bucle (ideal para pruebas).

    Respeta la cadencia original para no leer los 3000 frames del tirón y
    dejar la CPU al 100%.
    """

    label = "file"

    def _build_target(self):
        path = (self.camera.get("url") or "").strip()
        return path or None

    def open(self) -> bool:
        if not super().open():
            return False
        fps = self.cap.get(cv2.CAP_PROP_FPS) if self.cap else 0
        self.interval = 1.0 / fps if fps and 0 < fps < 120 else 1.0 / 25.0
        self._last_emit = 0.0
        return True

    interval = 0.04
    _last_emit = 0.0

    def read(self):
        now = time.time()
        wait = self.interval - (now - self._last_emit)
        if wait > 0.002:
            time.sleep(wait)
        self._last_emit = time.time()
        ok, frame = super().read()
        if not ok and self.cap is not None:
            # bucle infinito
            try:
                self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ok, frame = self.cap.read()
            except Exception:
                return False, None
        return ok, frame

    @property
    def record_url(self) -> str:
        return (self.camera.get("url") or "").strip()

    @property
    def ffmpeg_input_args(self) -> List[str]:
        return ["-stream_loop", "-1", "-re", "-i", self.record_url]


class DemoSource(Source):
    """Cámara sintética: patrón con objetos en movimiento y reloj.

    Permite ver el sistema funcionando (streaming, detección, eventos,
    alertas) sin tener hardware conectado.
    """

    label = "demo"

    fps = 12.0

    def __init__(self, camera: dict):
        super().__init__(camera)
        self.w, self.h = 1280, 720
        self.t0 = time.time()
        self.interval = 1.0 / self.fps
        self._last_emit = 0.0
        self._rng = np.random.default_rng(7)
        self._bg = self._make_background()

    def _make_background(self) -> np.ndarray:
        bg = np.full((self.h, self.w, 3), 36, dtype=np.uint8)
        cv2.rectangle(bg, (0, int(self.h * 0.62)), (self.w, self.h), (58, 52, 47), -1)
        for x in range(0, self.w, 80):  # rejilla
            cv2.line(bg, (x, 0), (x, self.h), (48, 48, 48), 1)
        for y in range(0, self.h, 80):
            cv2.line(bg, (0, y), (self.w, y), (48, 48, 48), 1)
        cv2.rectangle(bg, (60, 120), (260, 420), (70, 62, 55), -1)  # puerta
        cv2.putText(
            bg, "DEMO", (self.w - 150, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (120, 120, 120), 2
        )
        return bg

    def open(self) -> bool:
        self.t0 = time.time()
        return True

    def read(self):
        # Limita la cadencia para no comerse una CPU entera (la demo no tiene
        # un hardware real marcando el ritmo de los frames).
        now = time.time()
        elapsed = now - self._last_emit
        if elapsed < self.interval - 0.002:
            time.sleep(max(0.0, self.interval - elapsed - 0.002))
        self._last_emit = time.time()

        frame = self._bg.copy()
        t = time.time() - self.t0
        # objeto que cruza la escena cada ~12 s
        period = 12.0
        phase = (t % period) / period
        x = int(-120 + phase * (self.w + 240))
        y = int(self.h * 0.55)
        cv2.circle(frame, (x, y), 34, (70, 130, 220), -1)
        cv2.circle(frame, (x, y), 34, (30, 30, 30), 2)
        cv2.rectangle(frame, (x - 24, y + 30), (x + 24, y + 110), (70, 130, 220), -1)
        if t % period < 0.6:  # parpadeo para generar algo de ruido
            cv2.circle(frame, (int(self.w * 0.8), int(self.h * 0.3)), 18, (90, 200, 90), -1)
        cv2.putText(
            frame,
            time.strftime("%Y-%m-%d %H:%M:%S"),
            (20, self.h - 24),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (200, 200, 200),
            2,
        )
        return True, frame


def build_source(camera: dict) -> Source:
    stype = (camera.get("source_type") or "rtsp").lower()
    if stype == "rtsp":
        return RtspSource(camera)
    if stype == "usb":
        return UsbSource(camera)
    if stype == "file":
        return FileSource(camera)
    if stype == "demo":
        return DemoSource(camera)
    raise ValueError(f"Tipo de fuente desconocido: {stype}")


# --------------------------------------------------------------------------
# Utilidades de sondeo
# --------------------------------------------------------------------------
def ffmpeg_available() -> Optional[str]:
    from shutil import which

    return which("ffmpeg")


def list_usb_devices(max_index: int = 8) -> List[dict]:
    """Enumera índices de cámara USB/local que realmente abren."""
    found: List[dict] = []
    backend = _usb_backend()
    for idx in range(max_index):
        cap = None
        try:
            cap = cv2.VideoCapture(idx, backend)
            if not cap.isOpened():
                cap = cv2.VideoCapture(idx)
            if cap is not None and cap.isOpened():
                ok, frame = cap.read()
                if ok and frame is not None:
                    h, w = frame.shape[:2]
                    found.append(
                        {"index": idx, "width": int(w), "height": int(h), "name": f"Cámara {idx}"}
                    )
        except Exception:
            continue
        finally:
            if cap is not None:
                try:
                    cap.release()
                except Exception:
                    pass
    return found


def probe_snapshot(camera: dict, timeout: float = 8.0) -> Tuple[bool, Optional[np.ndarray], str]:
    """Abre la fuente y intenta leer un frame. Útil para 'probar conexión'."""
    src = build_source(camera)
    deadline = time.time() + timeout
    try:
        if not src.open():
            return False, None, "No se pudo abrir la fuente"
        while time.time() < deadline:
            ok, frame = src.read()
            if ok and frame is not None:
                return True, frame, ""
            time.sleep(0.1)
        return False, None, "Tiempo de espera agotado sin recibir imagen"
    except Exception as exc:  # pragma: no cover - defensivo
        return False, None, f"{type(exc).__name__}: {exc}"
    finally:
        try:
            src.release()
        except Exception:
            pass


def usb_device_names_windows() -> List[str]:  # pragma: no cover - sólo Windows
    """Lista nombres de dispositivos DirectShow vía ffmpeg (si está instalado)."""
    if not IS_WIN:
        return []
    exe = ffmpeg_available()
    if not exe:
        return []
    try:
        out = subprocess.run(
            [exe, "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
            capture_output=True,
            text=True,
            timeout=20,
        )
    except Exception:
        return []
    names: List[str] = []
    for line in (out.stderr or "").splitlines():
        if '"' in line and "video=" not in line.lower():
            start = line.find('"')
            end = line.rfind('"')
            if start != -1 and end > start:
                names.append(line[start + 1 : end])
    return names
