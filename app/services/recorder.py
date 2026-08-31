"""Grabación: segmentos continuos con ffmpeg y clips por evento.

Dos estrategias complementarias:

* **Continua**: ffmpeg lee la cámara directamente y copia el stream
  (``-c copy``) escribiendo segmentos de N minutos. Consumo de CPU ~0.
* **Por evento**: nosotros ya estamos decodificando frames para detectar
  movimiento, así que se los pasamos a ffmpeg por pipe (``rawvideo`` →
  ``libx264``) sólo mientras dura el evento, con pre-roll incluido.
"""

from __future__ import annotations


import platform
import subprocess
import threading
import time
from collections import deque
from pathlib import Path
from typing import Deque, List, Optional, Tuple

import cv2
import numpy as np

from ..logging_setup import get_logger

logger = get_logger("vigia.recorder")

IS_WIN = platform.system() == "Windows"


def ffmpeg_path() -> Optional[str]:
    """Localiza ffmpeg: PATH del sistema, o el binario que trae imageio-ffmpeg."""
    from shutil import which

    found = which("ffmpeg") or which("ffmpeg.exe")
    if found:
        return found
    try:  # alternativa vía pip: `pip install imageio-ffmpeg`
        import imageio_ffmpeg  # type: ignore

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def _popen(args: List[str], **kwargs):
    kwargs.setdefault("stdout", subprocess.DEVNULL)
    kwargs.setdefault("stderr", subprocess.PIPE)
    if IS_WIN:
        kwargs.setdefault("creationflags", getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return subprocess.Popen(args, **kwargs)


# --------------------------------------------------------------------------
# Grabación continua por segmentos
# --------------------------------------------------------------------------
class SegmentRecorder:
    """Mantiene vivo un proceso ffmpeg que trocea el stream en MP4."""

    def __init__(self, camera: dict, source, out_dir: Path, segment_seconds: int = 300,
                 codec: str = "copy", audio: bool = False, quality: str = "medium",
                 crf: int = 23, preset: str = "veryfast", bitrate: str = "",
                 width: int = 0, height: int = 0, fps: int = 0):
        self.camera = camera
        self.source = source
        self.out_dir = out_dir
        self.segment_seconds = max(10, int(segment_seconds))
        self.codec = codec
        self.audio = bool(audio)
        self.quality = quality
        self.crf = int(crf)
        self.preset = preset
        self.bitrate = bitrate or ""
        self.width = int(width or 0)
        self.height = int(height or 0)
        self.fps = int(fps or 0)
        self.proc: Optional[subprocess.Popen] = None
        self.last_start = 0.0
        self.last_error = ""
        self.files_written = 0
        self._stop = threading.Event()

    @staticmethod
    def _quality_defaults(quality: str) -> tuple:
        return {
            "high": (18, "medium"),
            "medium": (23, "veryfast"),
            "low": (28, "ultrafast"),
        }.get(quality or "medium", (23, "veryfast"))

    # ---------- construcción del comando ----------
    def build_cmd(self) -> Optional[List[str]]:
        exe = ffmpeg_path()
        if not exe:
            return None
        args: List[str] = [exe, "-hide_banner", "-nostdin", "-loglevel", "error", "-y"]
        in_args = list(self.source.ffmpeg_input_args)
        if not in_args:
            return None  # fuente sin soporte directo (demo)
        args += in_args
        if self.audio:
            args += ["-c:a", "aac", "-b:a", "64k"]
        else:
            args += ["-an"]

        # "Desea recodificar" si hay resolución/fps/bitrate explícitos: copiar
        # no puede cambiar esas cosas.
        force_reencode = bool(self.width or self.height or self.fps or self.bitrate)
        if self.codec == "copy" and not force_reencode:
            args += ["-c:v", "copy"]
        else:
            crf, preset = self._quality_defaults(self.quality)
            crf = self.crf or crf
            preset = self.preset or preset
            args += ["-c:v", "libx264", "-preset", preset, "-crf", str(crf),
                     "-pix_fmt", "yuv420p"]
            if self.bitrate:
                args += ["-b:v", self.bitrate]
            if self.width and self.height:
                args += ["-vf", f"scale={self.width}:{self.height}:force_original_aspect_ratio=decrease,pad={self.width}:{self.height}:(ow-iw)/2:(oh-ih)/2"]
            elif self.width:
                args += ["-vf", f"scale={self.width}:-2"]
            elif self.height:
                args += ["-vf", f"scale=-2:{self.height}"]
            if self.fps:
                args += ["-r", str(self.fps)]

        pattern = str(self.out_dir / "%Y%m%dT%H%M%S.mp4")
        args += [
            "-f", "segment",
            "-segment_time", str(self.segment_seconds),
            "-segment_format", "mp4",
            "-reset_timestamps", "1",
            "-strftime", "1",
            "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
            pattern,
        ]
        return args

    # ---------- ciclo de vida ----------
    def start(self) -> Tuple[bool, str]:
        self.out_dir.mkdir(parents=True, exist_ok=True)
        cmd = self.build_cmd()
        if not cmd:
            return False, "ffmpeg no disponible o fuente no grabable directamente"
        try:
            self.proc = _popen(cmd)
        except Exception as exc:
            self.last_error = f"{type(exc).__name__}: {exc}"
            return False, self.last_error
        self._stderr_lines = []
        threading.Thread(
            target=self._drain_stderr, args=(self.proc,), daemon=True
        ).start()
        self.last_start = time.time()
        self.last_error = ""
        return True, ""

    def _drain_stderr(self, proc) -> None:
        try:
            for line in proc.stderr:
                self._stderr_lines.append(line.decode("utf-8", "ignore"))
                if len(self._stderr_lines) > 40:
                    self._stderr_lines.pop(0)
        except Exception:
            pass

    def is_alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def ensure_running(self, max_restart_delay: float = 5.0) -> bool:
        """Reinicia ffmpeg si ha muerto, con backoff por antigüedad."""
        if self.is_alive():
            return True
        if self.proc is not None:
            try:
                err = (self.proc.stderr.read() or b"").decode("utf-8", "ignore")[-500:]
            except Exception:
                err = ""
            self.last_error = err.strip() or f"ffmpeg terminó (código {self.proc.returncode})"
            self.proc = None
        delay = min(max_restart_delay, 1.0 + (time.time() - self.last_start) / 10.0)
        if time.time() - self.last_start < delay:
            return False
        ok, _ = self.start()
        return ok

    def stop(self, timeout: float = 6.0) -> None:
        self._stop.set()
        proc = self.proc
        self.proc = None
        if proc is None:
            return
        if proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=timeout)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        try:
            if proc.stderr:
                proc.stderr.close()
        except Exception:
            pass


# --------------------------------------------------------------------------
# Clips por evento (frames nuestros -> ffmpeg -> mp4)
# --------------------------------------------------------------------------
class ClipRecorder:
    """Escribe un MP4 corto a partir de frames ya decodificados.

    Uso típico (modo 'motion'): el worker alimenta ``feed()`` con cada frame;
    al detectar movimiento llama a ``trigger()`` y el clip incluye los últimos
    ``pre_seconds`` (buffer circular) más ``post_seconds``.
    """

    def __init__(self, camera: dict, out_dir: Path, fps: float = 10.0,
                 pre_seconds: float = 5.0, post_seconds: float = 10.0,
                 max_seconds: float = 600.0, quality: str = "medium",
                 crf: int = 23, preset: str = "veryfast",
                 width: int = 0, height: int = 0):
        self.camera = camera
        self.out_dir = out_dir
        self.fps = max(1.0, float(fps))
        self.pre_seconds = max(0.0, float(pre_seconds))
        self.post_seconds = max(1.0, float(post_seconds))
        # Si el movimiento no cesa (hojas, lluvia, tráfico) el clip se corta
        # en trozos para que no crezca indefinidamente.
        self.max_seconds = max(30.0, float(max_seconds))
        self.quality = quality
        self.crf = int(crf)
        self.preset = preset
        self.width = int(width or 0)
        self.height = int(height or 0)
        self.started_at = 0.0
        self.buffer: Deque[Tuple[float, np.ndarray]] = deque()
        self._proc: Optional[subprocess.Popen] = None
        self._size: Optional[Tuple[int, int]] = None
        self._deadline = 0.0
        self._current_path: Optional[Path] = None
        self._lock = threading.Lock()
        self._last_write = 0.0

    # ---------- API ----------
    def feed(self, frame: np.ndarray, include_buffer: bool = True) -> Optional[str]:
        """Añade un frame al buffer y al clip en curso. Devuelve ruta al cerrar."""
        now = time.time()
        h, w = frame.shape[:2]
        self._size = (w, h)

        # buffer de pre-roll
        self.buffer.append((now, frame))
        cutoff = now - max(self.pre_seconds, 0.5)
        while self.buffer and self.buffer[0][0] < cutoff:
            self.buffer.popleft()
        if len(self.buffer) > 600:
            self.buffer.popleft()

        finished: Optional[str] = None
        if self._proc is not None:
            if now >= self._deadline or (now - self.started_at) >= self.max_seconds:
                finished = self._close()
                if frame is not None and now < self._deadline:
                    # movimiento continuo: seguimos en un fichero nuevo
                    self.trigger()
            else:
                self._write(frame)
        return finished

    def trigger(self) -> None:
        """Arranca la grabación volcando primero el pre-roll."""
        with self._lock:
            if self._proc is not None:
                # ya grabando: ampliamos la ventana
                self._deadline = max(self._deadline, time.time() + self.post_seconds)
                return
            if self._size is None:
                return
            path = self._new_path()
            if not self._spawn(path):
                return
            self._current_path = path
            now = time.time()
            self.started_at = now
            self._deadline = now + self.post_seconds
            for ts, frame in list(self.buffer):
                self._write(frame)

    def extend(self, seconds: Optional[float] = None) -> None:
        if self._proc is not None:
            self._deadline = max(
                self._deadline, time.time() + (seconds or self.post_seconds)
            )

    @property
    def recording(self) -> bool:
        return self._proc is not None

    def stop(self) -> Optional[str]:
        with self._lock:
            return self._close()

    # ---------- interno ----------
    def _new_path(self) -> Path:
        self.out_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%dT%H%M%S")
        cam = (self.camera.get("id") or "cam")[:24]
        return self.out_dir / f"clip_{cam}_{stamp}.mp4"

    def _spawn(self, path: Path) -> bool:
        exe = ffmpeg_path()
        if not exe or self._size is None:
            return False
        w, h = self._size
        if self.width and self.height:
            w, h = self.width, self.height
        elif self.width:
            scale = self.width / max(1, self._size[0])
            h = max(2, int(self._size[1] * scale))
            w = self.width
        elif self.height:
            scale = self.height / max(1, self._size[1])
            w = max(2, int(self._size[0] * scale))
            h = self.height
        crf, preset = SegmentRecorder._quality_defaults(self.quality)
        cmd = [
            exe, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
            "-f", "rawvideo", "-pix_fmt", "bgr24",
            "-s", f"{w}x{h}", "-r", f"{self.fps:.3f}", "-i", "-",
            "-an", "-c:v", "libx264", "-preset", preset, "-crf", str(self.crf or crf),
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(path),
        ]
        try:
            self._proc = _popen(cmd, stdin=subprocess.PIPE)
        except Exception as exc:
            self._proc = None
            self.last_error = f"{type(exc).__name__}: {exc}"
            return False
        self._stderr_lines = []
        threading.Thread(
            target=self._drain_stderr, args=(self._proc,), daemon=True
        ).start()
        return True

    def _drain_stderr(self, proc) -> None:
        """Lee stderr en un hilo: si no se vacía, ffmpeg se bloquea al llenar
        el buffer de la tubería."""
        try:
            for line in proc.stderr:
                self._stderr_lines.append(line.decode("utf-8", "ignore"))
                if len(self._stderr_lines) > 60:
                    self._stderr_lines.pop(0)
        except Exception:
            pass

    def _write(self, frame: np.ndarray) -> None:
        if self._proc is None or self._proc.stdin is None:
            return
        try:
            if self.width and self.height and (frame.shape[1] != self.width or frame.shape[0] != self.height):
                frame = cv2.resize(frame, (self.width, self.height))
            elif self.width and frame.shape[1] != self.width:
                frame = cv2.resize(frame, (self.width, int(frame.shape[0] * (self.width / max(1, frame.shape[1])))))
            elif self.height and frame.shape[0] != self.height:
                frame = cv2.resize(frame, (int(frame.shape[1] * (self.height / max(1, frame.shape[0]))), self.height))
            if frame is not None:
                self._proc.stdin.write(frame.tobytes())
        except Exception:
            try:
                if self._proc.stdin:
                    self._proc.stdin.close()
            except Exception:
                pass
            self._proc = None

    def _close(self) -> Optional[str]:
        proc = self._proc
        self._proc = None
        path = self._current_path
        self._current_path = None
        if proc is None:
            return None
        try:
            if proc.stdin:
                proc.stdin.flush()
                proc.stdin.close()
        except Exception:
            pass
        try:
            proc.wait(timeout=8)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        size = path.stat().st_size if path and path.exists() else 0
        if path and size > 1024:
            return str(path)
        err = "".join(getattr(self, "_stderr_lines", []) or []).strip()[-400:]
        if err:
            logger.warning("Clip descartado (%s bytes). ffmpeg: %s", size, err)
            self.last_error = err
        if path and path.exists():
            try:
                path.unlink()
            except Exception:
                pass
        return None


# --------------------------------------------------------------------------
# Fallback sin ffmpeg: OpenCV VideoWriter
# --------------------------------------------------------------------------
class Cv2ClipWriter:
    def __init__(self, out_dir: Path, fps: float = 10.0):
        self.out_dir = out_dir
        self.fps = fps
        self.writer: Optional[cv2.VideoWriter] = None
        self.path: Optional[Path] = None

    def start(self, size: Tuple[int, int], name: str) -> bool:
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.out_dir / f"{name}.mp4"
        for fourcc in ("avc1", "mp4v", "XVID"):
            try:
                writer = cv2.VideoWriter(
                    str(self.path), cv2.VideoWriter_fourcc(*fourcc), self.fps, size
                )
                if writer.isOpened():
                    self.writer = writer
                    return True
            except Exception:
                continue
        return False

    def write(self, frame: np.ndarray) -> None:
        if self.writer is not None:
            self.writer.write(frame)

    def stop(self) -> Optional[str]:
        if self.writer is None:
            return None
        try:
            self.writer.release()
        except Exception:
            pass
        self.writer = None
        return str(self.path) if self.path and self.path.exists() else None
