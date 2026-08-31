"""Modelos Pydantic y fábricas de objetos del dominio."""

from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional
from urllib.parse import urlsplit, urlunsplit

from pydantic import BaseModel, Field

SOURCE_TYPES = ("rtsp", "usb", "file", "demo")


def new_id(prefix: str = "") -> str:
    return f"{prefix}{uuid.uuid4().hex[:12]}"


def utc_now() -> datetime:
    return datetime.utcnow()


def iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat() + "Z"


# --------------------------------------------------------------------------
# RTSP helpers
# --------------------------------------------------------------------------
# Rutas XMEye/iCSee: credenciales dentro de la ruta (user=..&password=..).
_XMEYE_PATH_RE = re.compile(r"(user=)[^&/?\s]*(&password=)[^&/?\s]*", re.I)
_XMEYE_UNDERSCORE_RE = re.compile(r"(user=)[^_?\s]*(_password=)[^_?\s]*", re.I)


def with_credentials(url: str, username: str = "", password: str = "") -> str:
    """Inyecta usuario/contraseña en una URL rtsp:// si no los trae ya.

    - URL estándar (``rtsp://host/ruta``): credenciales en el usuario de la URL.
    - URL XMEye/iCSee (``.../user=..&password=..&channel=..`` o variante con
      guiones bajos): se reescriben las credenciales dentro de la propia ruta.
    """
    if not url or not username:
        return url
    if _XMEYE_PATH_RE.search(url):
        return _XMEYE_PATH_RE.sub(
            lambda m: f"user={username}&password={password}", url, count=1
        )
    if _XMEYE_UNDERSCORE_RE.search(url):
        return _XMEYE_UNDERSCORE_RE.sub(
            lambda m: f"user={username}_password={password}", url, count=1
        )
    parts = urlsplit(url)
    if parts.username:
        return url
    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    netloc = f"{username}:{password}@{host}"
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


def redact(url: str) -> str:
    """Oculta credenciales para logs y respuestas de la API."""
    if not url:
        return url
    parts = urlsplit(url)
    if not parts.username:
        return url
    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    return urlunsplit((parts.scheme, f"***:***@{host}", parts.path, parts.query, parts.fragment))


def guess_name_from_url(url: str) -> str:
    parts = urlsplit(url or "")
    if parts.hostname:
        return f"Cámara {parts.hostname}"
    return "Cámara"


# --------------------------------------------------------------------------
# Sub-modelos
# --------------------------------------------------------------------------
class OnvifConfig(BaseModel):
    enabled: bool = False
    host: str = ""            # ip o ip:puerto
    port: int = 80
    username: str = ""
    password: str = ""
    profile_token: str = ""   # perfil PTZ (vacío = primero disponible)
    use_onvif_stream: bool = True


class DetectionConfig(BaseModel):
    enabled: bool = True
    sensitivity: int = 55
    min_area: int = 1200
    fps: int = 6
    detect_width: int = 640
    cooldown_seconds: int = 20
    zones: List[List[List[float]]] = Field(default_factory=list)
    zone_mode: Literal["include", "exclude"] = "include"
    ai_enabled: bool = False
    ai_labels: List[str] = Field(default_factory=lambda: ["person", "car", "dog", "cat"])
    ai_confidence: float = 0.45
    ai_model: str = "yolov8n.pt"


class RecordingConfig(BaseModel):
    mode: Literal["continuous", "motion", "off"] = "continuous"
    segment_seconds: int = 300
    pre_seconds: int = 5
    post_seconds: int = 10
    codec: Literal["copy", "h264"] = "copy"
    audio: bool = False


class AlertConfig(BaseModel):
    enabled: bool = True
    channels: List[str] = Field(default_factory=list)  # vacío = todos los activos
    only_when_away: bool = False


class CameraBase(BaseModel):
    name: str
    enabled: bool = True
    source_type: Literal["rtsp", "usb", "file", "demo"] = "rtsp"
    url: str = ""             # rtsp://... | ruta de fichero | (demo: ignorado)
    substream_url: str = ""   # opcional: flujo secundario para detección/live
    username: str = ""
    password: str = ""
    device_index: int = 0     # usb
    device_name: str = ""     # usb en Windows (dshow) / macOS (avfoundation)
    group: str = ""           # etiqueta libre: "Entrada", "Garaje"...
    onvif: OnvifConfig = Field(default_factory=OnvifConfig)
    detection: DetectionConfig = Field(default_factory=DetectionConfig)
    recording: RecordingConfig = Field(default_factory=RecordingConfig)
    alerts: AlertConfig = Field(default_factory=AlertConfig)


class CameraCreate(CameraBase):
    pass


class CameraUpdate(BaseModel):
    """Patch parcial: sólo los campos enviados se modifican."""

    name: Optional[str] = None
    enabled: Optional[bool] = None
    source_type: Optional[str] = None
    url: Optional[str] = None
    substream_url: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None
    device_index: Optional[int] = None
    device_name: Optional[str] = None
    group: Optional[str] = None
    onvif: Optional[Dict[str, Any]] = None
    detection: Optional[Dict[str, Any]] = None
    recording: Optional[Dict[str, Any]] = None
    alerts: Optional[Dict[str, Any]] = None


class Camera(CameraBase):
    id: str
    created_at: str = ""
    # Estado en vivo (lo rellena el manager, no se persiste)
    state: str = "stopped"
    health: Dict[str, Any] = Field(default_factory=dict)


# --------------------------------------------------------------------------
# Fábricas
# --------------------------------------------------------------------------
def build_camera(payload: Dict[str, Any], defaults: Dict[str, Any]) -> Dict[str, Any]:
    """Crea el dict de cámara aplicando los valores por defecto globales."""
    det = {**defaults.get("detection", {})}
    rec = {**defaults.get("recording", {})}
    det.update(payload.get("detection") or {})
    rec.update(payload.get("recording") or {})
    det.pop("ai_model", None) if False else None  # no-op, keep key

    cam: Dict[str, Any] = {
        "id": payload.get("id") or new_id("cam_"),
        "name": payload.get("name") or guess_name_from_url(payload.get("url", "")),
        "enabled": bool(payload.get("enabled", True)),
        "source_type": payload.get("source_type") or "rtsp",
        "url": payload.get("url", ""),
        "substream_url": payload.get("substream_url", ""),
        "username": payload.get("username", ""),
        "password": payload.get("password", ""),
        "device_index": int(payload.get("device_index", 0) or 0),
        "device_name": payload.get("device_name", ""),
        "group": payload.get("group", ""),
        "onvif": {**OnvifConfig().model_dump(), **(payload.get("onvif") or {})},
        "detection": {**DetectionConfig().model_dump(), **det, **(payload.get("detection") or {})},
        "recording": {**RecordingConfig().model_dump(), **rec, **(payload.get("recording") or {})},
        "alerts": {**AlertConfig().model_dump(), **(payload.get("alerts") or {})},
        "created_at": payload.get("created_at") or iso(utc_now()),
        "state": "stopped",
        "health": {},
    }
    # Hereda el modelo de IA global si la cámara no define uno propio
    if not (payload.get("detection") or {}).get("ai_model"):
        cam["detection"]["ai_model"] = defaults.get("detection", {}).get(
            "ai_model", "yolov8n.pt"
        )
    return cam


# --------------------------------------------------------------------------
# Eventos
# --------------------------------------------------------------------------
class Event(BaseModel):
    id: str
    camera_id: str
    camera_name: str = ""
    ts: str
    label: str = "motion"        # motion | person | car | ...
    score: float = 0.0
    boxes: List[List[int]] = Field(default_factory=list)
    snapshot: str = ""           # ruta relativa
    clip: str = ""
    notified: List[str] = Field(default_factory=list)
    acknowledged: bool = False
    notes: str = ""


# --------------------------------------------------------------------------
# Utilidades varias
# --------------------------------------------------------------------------
_slug_re = re.compile(r"[^a-z0-9]+")


def slugify(text: str) -> str:
    return _slug_re.sub("-", (text or "").lower()).strip("-") or "cam"
