"""Fuentes de vídeo: RTSP, USB, fichero y una cámara sintética de demo.

Todas exponen la misma interfaz mínima (``open`` / ``read`` / ``release``)
para que el worker de cámara sea agnóstico al origen.
"""

from __future__ import annotations

import platform
import re
import struct
import subprocess
import threading
import time
from abc import ABC, abstractmethod
from typing import List, Optional, Tuple
from urllib.parse import urlsplit

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
        self.last_error = ""

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
            self.last_error = "No se pudo construir la fuente de vídeo"
            return False
        self.release()
        self.last_error = ""
        try:
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
        except Exception as exc:
            self.last_error = f"{type(exc).__name__}: {exc}"
        self.cap = None
        if not self.last_error:
            self.last_error = "OpenCV no pudo abrir la fuente RTSP/USB/vídeo"
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


class FfmpegRTSPReader:
    """Lector RTSP basado en el binario de ffmpeg (contenido en imageio-ffmpeg).

    Es un respaldo muy útil para cámaras XMEye/iCSee: algunas URLs
    ``user=...&password=...&channel=...`` que OpenCV no abre sí funcionan con
    ffmpeg y ``-rtsp_transport tcp``. Lee frames BGR (bgr24) por el pipe y los
    entrega como numpy arrays.
    """

    label = "rtsp-ffmpeg"
    first_frame_timeout = 8.0  # segundos; evita colgarse con URLs que "abren" pero no envían vídeo

    def __init__(self, url: str, width: int = 640, height: int = 480):
        self.url = url
        self.width = int(width or 640)
        self.height = int(height or 480)
        self.proc: Optional[subprocess.Popen] = None
        self.frame_size = self.width * self.height * 3
        self.last_error = ""
        self._stderr_lines: List[str] = []

    @staticmethod
    def _ffmpeg_bin() -> Optional[str]:
        from shutil import which
        found = which("ffmpeg") or which("ffmpeg.exe")
        if found:
            return found
        try:
            import imageio_ffmpeg  # type: ignore
            return imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            return None

    def _drain_stderr(self) -> None:
        if self.proc is None or self.proc.stderr is None:
            return
        try:
            for line in self.proc.stderr:
                self._stderr_lines.append(line.decode("utf-8", "ignore").strip())
                if len(self._stderr_lines) > 25:
                    self._stderr_lines.pop(0)
        except Exception:
            pass

    def _error_text(self) -> str:
        for line in reversed(self._stderr_lines):
            if line:
                # No exponer credenciales en el diagnóstico.
                line = re.sub(r"(rtsp://)[^@\s]+@", r"\1***:***@", line)
                line = re.sub(r"(user=)[^&\s/]+", r"\1***", line)
                line = re.sub(r"((?:password|passwd)=)[^&\s/]+", r"\1***", line, flags=re.I)
                return line
        return "ffmpeg no produjo imagen (URL o credenciales incorrectas)"

    def open(self) -> bool:
        self.close()
        exe = self._ffmpeg_bin()
        if not exe:
            self.last_error = "ffmpeg no está disponible"
            return False
        args = [
            exe, "-hide_banner", "-loglevel", "error",
            "-rtsp_transport", "tcp",
            "-fflags", "nobuffer", "-flags", "low_delay",
            "-i", self.url,
            "-f", "rawvideo", "-pix_fmt", "bgr24",
            "-s", f"{self.width}x{self.height}",
            "-",
        ]
        try:
            spawn_kwargs: dict = {
                "stdout": subprocess.PIPE,
                "stderr": subprocess.PIPE,
                "bufsize": self.frame_size,
            }
            if IS_WIN:
                # Evita la ventana negra de consola en Windows al abrir cada
                # flujo RTSP (los reintentos la hacían parpadear continuamente).
                spawn_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            self.proc = subprocess.Popen(args, **spawn_kwargs)
        except Exception as exc:
            self.last_error = f"{type(exc).__name__}: {exc}"
            self.proc = None
            return False
        threading.Thread(target=self._drain_stderr, daemon=True, name="vigia-ffmpeg-stderr").start()

        # Esperamos el primer frame con timeout. ffmpeg puede tardar en
        # negociar; pero si no llega, preferimos fallar pronto y avisar.
        frames: List[Optional[np.ndarray]] = []
        waiter = threading.Thread(
            target=lambda: frames.append(self._read_raw()),
            name="vigia-ffmpeg-first-frame",
            daemon=True,
        )
        waiter.start()
        waiter.join(self.first_frame_timeout)
        if waiter.is_alive():
            self.last_error = f"ffmpeg tardó más de {self.first_frame_timeout:.0f}s en dar vídeo"
            self.close()
            return False
        frame = frames[0] if frames else None
        if frame is None:
            self.last_error = self._error_text()
            self.close()
            return False
        self.last_error = ""
        return True

    def _read_raw(self) -> Optional[np.ndarray]:
        if self.proc is None or self.proc.stdout is None or self.proc.poll() is not None:
            return None
        raw = self.proc.stdout.read(self.frame_size)
        if not raw or len(raw) != self.frame_size:
            return None
        return np.frombuffer(raw, dtype=np.uint8).reshape(
            (self.height, self.width, 3)
        )

    def read(self) -> Tuple[bool, Optional[np.ndarray]]:
        frame = self._read_raw()
        return (True, frame) if frame is not None else (False, None)

    def release(self) -> None:
        self.close()

    def close(self) -> None:
        if self.proc is not None:
            try:
                self.proc.stdin.close()  # type: ignore[union-attr]
            except Exception:
                pass
            try:
                self.proc.kill()
            except Exception:
                pass
            try:
                self.proc.wait(timeout=1)
            except Exception:
                pass
        self.proc = None


class DvripSource(Source):
    """Fuente nativa por DVRIP/NetIP (puerto 34567) para iCSee/XMEye.

    Muchas multi-lente no exponen cada lente por RTSP (``channel=1/2/3`` no
    cambia de lente), pero sí por el protocolo que usa la app. Aquí abrimos el
    canal por DVRIP y lo decodificamos con ffmpeg para poder verlo, detectar
    movimiento y grabar clips (modo motion/smart).
    """

    label = "dvrip"
    first_frame_timeout = 6.0

    def __init__(self, camera: dict):
        super().__init__(camera)
        self.client = None
        self.control_sock = None
        self.data_sock = None
        self.raw = None
        self._ff_proc: Optional[subprocess.Popen] = None
        self._writer: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._codec = "h264"
        self._got_frame = False

    @staticmethod
    def _ffmpeg_bin() -> Optional[str]:
        from .recorder import ffmpeg_path
        return ffmpeg_path()

    def _config(self) -> dict:
        cam = self.camera
        dvrip = cam.get("dvrip") or {}
        url = cam.get("url") or ""
        host = dvrip.get("host") or ""
        port = int(dvrip.get("port") or 34567)
        if not host and url:
            m = re.match(r"dvrip://(?:[^@/]+@)?([^:/\s]+)(?::(\d+))?(?:/[^?]*)?(?:\?.*)?", url)
            if m:
                host = m.group(1) or host
                if m.group(2):
                    port = int(m.group(2))
        if not host:
            onvif = cam.get("onvif") or {}
            host = onvif.get("host") or ""
        channel = int(dvrip.get("channel", 0) or 0)
        if "dvrip" not in cam or not dvrip:
            qm = re.search(r"[?&]channel=(\d+)", url)
            if qm:
                channel = int(qm.group(1)) - 1
        if channel < 0:
            channel = 0
        stream = str(dvrip.get("stream") or "main")
        codec = str(dvrip.get("codec") or "auto")
        if codec not in ("h264", "h265", "hevc"):
            codec = "h264"
        return {
            "host": host,
            "port": port,
            "channel": channel,
            "stream": stream,
            "codec": codec,
            "username": cam.get("username", ""),
            "password": cam.get("password", ""),
        }

    def open(self) -> bool:
        cfg = self._config()
        if not cfg["host"]:
            self.last_error = "No hay host DVRIP configurado"
            return False
        from .dvrip import stream_channel

        # Demuxers a probar. "auto" prueba h264 y, si no llega vídeo, hevc
        # (muchas iCSee/XMEye graban H.265/HEVC en el flujo principal).
        if cfg["codec"] in ("h265", "hevc"):
            codecs = ["hevc"]
        elif cfg["codec"] in ("h264",):
            codecs = ["h264"]
        else:
            codecs = ["h264", "hevc"]

        last_error = ""
        for codec in codecs:
            self._cleanup()  # cierra un intento previo antes de reconectar
            self._got_frame = False
            self._stop.clear()
            self._codec = codec
            try:
                client, data_sock, control_sock, raw = stream_channel(
                    cfg["host"], cfg["username"], cfg["password"], cfg["channel"],
                    port=cfg["port"], stream=cfg["stream"],
                )
            except Exception as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                continue
            self.client, self.data_sock, self.control_sock, self.raw = (
                client, data_sock, control_sock, raw
            )
            if self._start_ffmpeg(codec):
                return True
            last_error = self.last_error or last_error

        self.last_error = last_error or "DVRIP conectado pero no llegó vídeo del canal"
        self._cleanup()
        return False

    def _start_ffmpeg(self, demux: str) -> bool:
        """Arranca ffmpeg (con el demuxer dado) y espera el primer frame real."""
        exe = self._ffmpeg_bin()
        if not exe:
            self.last_error = "ffmpeg no está disponible para decodificar DVRIP"
            return False
        try:
            spawn_kwargs: dict = {
                "stdin": subprocess.PIPE,
                "stdout": subprocess.PIPE,
                "stderr": subprocess.PIPE,
                "bufsize": 1 << 20,
            }
            if IS_WIN:
                # Sin ventana de consola al decodificar DVRIP.
                spawn_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            self._ff_proc = subprocess.Popen(
                [
                    exe, "-hide_banner", "-nostdin", "-loglevel", "error",
                    "-f", demux, "-i", "-",
                    "-f", "image2pipe", "-vcodec", "bmp", "-",
                ],
                **spawn_kwargs,
            )
        except Exception as exc:
            self.last_error = f"{type(exc).__name__}: {exc}"
            self._ff_proc = None
            return False
        self._stop.clear()
        self._writer = threading.Thread(target=self._feed_ffmpeg, daemon=True, name="dvrip-writer")
        self._writer.start()

        # Espera el primer frame real (evita falsos "conectado").
        waiter = threading.Thread(target=self._wait_first_frame, daemon=True)
        waiter.start()
        waiter.join(self.first_frame_timeout)
        if waiter.is_alive() or not self._got_frame:
            self.last_error = f"DVRIP no dio vídeo con demux {demux}"
            return False
        self.last_error = ""
        return True

    def _wait_first_frame(self) -> None:
        try:
            frame = self._read_one_frame(block=False)
            if frame is not None:
                self._got_frame = True
        except Exception:
            pass

    def _feed_ffmpeg(self) -> None:
        if not self._ff_proc or not self.raw:
            return
        try:
            while not self._stop.is_set():
                chunk = self.raw.read(65536)
                if not chunk:
                    break
                if self._ff_proc.stdin is not None:
                    self._ff_proc.stdin.write(chunk)
                    self._ff_proc.stdin.flush()
        except Exception:
            pass

    def _read_exact(self, n: int) -> Optional[bytes]:
        if self._ff_proc is None or self._ff_proc.stdout is None:
            return None
        buf = bytearray()
        while len(buf) < n and not self._stop.is_set():
            chunk = self._ff_proc.stdout.read(n - len(buf))
            if not chunk:
                return None if not buf else bytes(buf)
            buf.extend(chunk)
        return bytes(buf[:n])

    @staticmethod
    def _parse_bmp(data: bytes) -> Optional[np.ndarray]:
        try:
            if len(data) < 54:
                return None
            bpp = int(struct.unpack("<H", data[28:30])[0])
            h = int(struct.unpack("<i", data[22:26])[0])
            w = int(struct.unpack("<i", data[18:22])[0])
            if abs(h) <= 0 or w <= 0 or bpp != 24:
                return None
            offset = int(struct.unpack("<I", data[10:14])[0]) or 54
            if len(data) < offset + w * abs(h) * 3:
                return None
            frame = np.frombuffer(data[offset:offset + w * abs(h) * 3], dtype=np.uint8)
            return frame.reshape((abs(h), w, 3))
        except Exception:
            return None

    def _read_one_frame(self, block: bool = True) -> Optional[np.ndarray]:
        """Lee un BMP de la salida de ffmpeg; devuelve un frame BGR."""
        if self._ff_proc is None:
            return None
        header = self._read_exact(14)
        if not header or len(header) < 14:
            return None
        size = struct.unpack("<I", header[2:6])[0]
        if size <= 14:
            return None
        body = self._read_exact(size - 14)
        if not body or len(body) < size - 14:
            return None
        return self._parse_bmp(header + body)

    def read(self) -> Tuple[bool, Optional[np.ndarray]]:
        frame = self._read_one_frame()
        return (True, frame) if frame is not None else (False, None)

    def release(self) -> None:
        self._cleanup()

    def _cleanup(self) -> None:
        self._stop.set()
        if self._ff_proc is not None:
            try:
                if self._ff_proc.stdin is not None:
                    self._ff_proc.stdin.close()
            except Exception:
                pass
            try:
                self._ff_proc.kill()
            except Exception:
                pass
            try:
                self._ff_proc.wait(timeout=1)
            except Exception:
                pass
            try:
                if self._ff_proc.stderr is not None:
                    self._ff_proc.stderr.close()
            except Exception:
                pass
        self._ff_proc = None
        if self.raw is not None:
            try:
                self.raw.close()
            except Exception:
                pass
        self.raw = None
        if self.data_sock is not None:
            try:
                self.data_sock.close()
            except Exception:
                pass
        self.data_sock = None
        if self.client is not None:
            try:
                self.client.logout()
            except Exception:
                pass
        self.client = None
        if self.control_sock is not None:
            try:
                self.control_sock.close()
            except Exception:
                pass
        self.control_sock = None


class RtspSource(Cv2Source):
    label = "rtsp"
    first_frame_timeout = 8.0

    def __init__(self, camera: dict):
        super().__init__(camera)
        self.ffmpeg: Optional[FfmpegRTSPReader] = None
        self.dvrip_fallback: Optional[DvripSource] = None

    def _build_target(self):
        cam = self.camera
        url = cam.get("substream_url") or cam.get("url") or ""
        if not url:
            return None
        url = with_credentials(url, cam.get("username", ""), cam.get("password", ""))
        return url

    @staticmethod
    def _is_icsee_target(target: str) -> bool:
        t = target
        return (("user=" in t or "user%3D" in t)
                and ("password=" in t or "passwd=" in t
                     or "password%3D" in t or "passwd%3D" in t))

    def _build_dvrip_camera(self, target: str) -> dict:
        """Copia de la cámara como DVRIP/NetIP para iCSee multi-lente."""
        cam = dict(self.camera)
        urlhost = urlsplit(target)
        host = urlhost.hostname or ""
        parts = urlsplit(self.camera.get("url") or "")
        host = host or parts.hostname or ""
        dvrip = dict(cam.get("dvrip") or {})
        dvrip.setdefault("enabled", True)
        dvrip.setdefault("stream", "main")
        dvrip.setdefault("codec", "auto")
        if host:
            dvrip["host"] = host
        dvrip["port"] = int(dvrip.get("port") or 34567)
        # RTSP channel=1/2/3 de XMEye suele ser lente 1/2/3; DVRIP es 0/1/2.
        m = re.search(r"[?&_]channel=(\d+)", target or self.camera.get("url", ""), re.I)
        if m:
            rtsp_ch = int(m.group(1))
            dvrip["channel"] = max(0, rtsp_ch - 1) if rtsp_ch > 0 else 0
        else:
            dvrip.setdefault("channel", 0)
        cam["source_type"] = "dvrip"
        cam["dvrip"] = dvrip
        cam["url"] = f"dvrip://{host}:{dvrip['port']}/channel={int(dvrip.get('channel', 0) or 0) + 1}"
        return cam

    def _open_dvrip_fallback(self, target: str) -> bool:
        """Intenta iCSee vía DVRIP/NetIP cuando RTSP da 401 o no abre."""
        try:
            src = DvripSource(self._build_dvrip_camera(target))
            if src.open():
                self.dvrip_fallback = src
                self.last_error = ""
                return True
            self.last_error = getattr(src, "last_error", "") or "DVRIP no pudo abrir el canal"
        except Exception as exc:
            self.last_error = f"{type(exc).__name__}: {exc}"
        return False

    def open(self) -> bool:
        target = self._build_target()
        if target is None:
            self.last_error = "La cámara no tiene URL RTSP"
            return False
        self.last_error = ""

        # 1) RTSP primero: es lo que el usuario eligió al añadir la cámara por
        #    URL RTSP. OpenCV es rápido; si "abre" pero no da frames, soltamos y
        #    probamos el lector ffmpeg (rtsp_transport tcp), más fiable con iCSee.
        if super().open():
            frames: List[Tuple[bool, Optional[np.ndarray]]] = []
            waiter = threading.Thread(
                target=lambda: frames.append(super().read()),
                name="vigia-opencv-first-frame",
                daemon=True,
            )
            waiter.start()
            waiter.join(self.first_frame_timeout)
            if not waiter.is_alive() and frames and frames[0][0] and frames[0][1] is not None:
                return True
            self.release()  # el handle OpenCV no producía vídeo

        try:
            self.ffmpeg = FfmpegRTSPReader(target)
            if self.ffmpeg.open():
                self.last_error = ""
                return True
            self.last_error = self.ffmpeg.last_error or "No se pudo abrir el flujo RTSP"
            self.ffmpeg = None
        except Exception as exc:
            self.last_error = f"{type(exc).__name__}: {exc}"
            self.ffmpeg = None

        # 2) Respaldo DVRIP/NetIP (34567) para iCSee/XMEye: cuando RTSP responde
        #    401 o no cambia de lente, el protocolo propietario suele abrir cada
        #    lente. Sólo si la URL parece iCSee o si dvrip.enabled está activo.
        want_dvrip = bool((self.camera.get("dvrip") or {}).get("enabled")) or self._is_icsee_target(target)
        if want_dvrip:
            try:
                from .dvrip import available as dvrip_available

                if dvrip_available() and self._open_dvrip_fallback(target):
                    return True
            except Exception as exc:
                self.last_error = f"{type(exc).__name__}: {exc}"

        return False

    def read(self):
        if self.dvrip_fallback is not None:
            return self.dvrip_fallback.read()
        if self.ffmpeg is not None:
            return self.ffmpeg.read()
        return super().read()

    def release(self):
        super().release()
        if self.ffmpeg is not None:
            try:
                self.ffmpeg.release()
            except Exception:
                pass
            self.ffmpeg = None
        if self.dvrip_fallback is not None:
            try:
                self.dvrip_fallback.release()
            except Exception:
                pass
            self.dvrip_fallback = None

    @property
    def record_url(self) -> str:
        if self.dvrip_fallback is not None:
            # DVRIP no se graba con ffmpeg RTSP; mejor no intentar abrir un
            # flujo que ya sabemos que da 401 (evita ventanas y logs).
            return ""
        cam = self.camera
        return with_credentials(cam.get("url") or "", cam.get("username", ""), cam.get("password", ""))

    @property
    def ffmpeg_input_args(self) -> List[str]:
        if self.dvrip_fallback is not None:
            return []
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
    if stype == "dvrip":
        return DvripSource(camera)
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
            return False, None, getattr(src, "last_error", "") or "No se pudo abrir la fuente"
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
