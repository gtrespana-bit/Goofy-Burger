"""Configuración global y persistencia ligera en JSON.

Todo vive en ``data/config.json``. No hay base de datos: para un NVR casero
de 2-16 cámaras un fichero JSON es más que suficiente y facilita copiar la
configuración de un sitio a otro.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import threading
from pathlib import Path
from typing import Any, Dict

BASE_DIR = Path(__file__).resolve().parent.parent


def _os_appdata_dir() -> Path:
    """Carpeta de datos del usuario para cada sistema operativo.

    Se usa para que la configuración, grabaciones y eventos sobrevivan a
    actualizaciones y a que el .exe empaquetado se mueva de sitio.
    """
    if os.name == "nt":
        root = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(root) / "Vigia"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Vigia"
    xdg = os.environ.get("XDG_DATA_HOME")
    if xdg:
        return Path(xdg) / "vigia"
    return Path.home() / ".local" / "share" / "vigia"


def default_data_dir() -> Path:
    """Determina la carpeta de datos (config + grabaciones) de forma estable.

    Preferencias:
      1. Variable VIGIA_DATA_DIR (la usa el instalador/ejecutable).
      2. Si ya existe una carpeta ``data/`` junto al código (instalaciones
         antiguas desde el código fuente), se mantiene para no perder nada.
      3. Carpeta de datos del usuario del SO (recomendado: sobrevive a
         actualizaciones y a un .exe empaquetado con PyInstaller).
    """
    env = os.environ.get("VIGIA_DATA_DIR")
    if env:
        return Path(env).expanduser().resolve()
    if not getattr(sys, "frozen", False):
        local = (BASE_DIR / "data").resolve()
        if local.exists():
            return local
    return _os_appdata_dir().resolve()


DATA_DIR = default_data_dir()
CONFIG_PATH = DATA_DIR / "config.json"

RECORDINGS_DIRNAME = "recordings"
SNAPSHOTS_DIRNAME = "snapshots"
CLIPS_DIRNAME = "clips"
EVENTS_FILENAME = "events.json"


def default_config() -> Dict[str, Any]:
    return {
        "version": 2,
        "general": {
            "system_name": "Vigía Pro",
            "edition": "Pro",
            # Zona horaria para mostrar horas; None = la del sistema.
            "timezone": None,
            "auth_enabled": False,
            "username": "admin",
            "show_frame_overlay": True,
            # Contraseña en texto plano (se guarda hash si se cambia desde la UI)
            "password_hash": "",
        },
        "storage": {
            "recordings_dir": str(DATA_DIR / RECORDINGS_DIRNAME),
            "snapshots_dir": str(DATA_DIR / SNAPSHOTS_DIRNAME),
            "clips_dir": str(DATA_DIR / CLIPS_DIRNAME),
            "retention_days": 14,
            "max_storage_gb": 100,
            "prune_interval_minutes": 30,
            "thumbnails": True,
        },
        "detection": {
            # Valores por defecto que heredan las cámaras nuevas.
            "enabled": True,
            "sensitivity": 55,          # 1-100
            "min_area": 1200,           # px^2 sobre el frame de detección
            "fps": 6,                   # fps a los que se analiza
            "detect_width": 640,        # ancho al que se reescala para detectar
            "cooldown_seconds": 20,     # mínimo entre eventos de la misma cámara
            "zones": [],                # zonas (polígonos) por defecto
            "zone_mode": "include",     # include | exclude
            "privacy_mask": [],
            "ignore_light_change": True,
            "max_events_per_minute": 0,
            "tamper_enabled": False,
            "tamper_sensitivity": 40,
            "schedule": [],
            "ai_enabled": False,
            "ai_labels": ["person", "car", "truck", "dog", "cat"],
            "ai_confidence": 0.45,
            "ai_model": "yolov8n.pt",
            "ai_every_n": 3,
            "ai_imgsz": 640,
        },
        "recording": {
            "mode": "continuous",       # continuous | motion | smart | scheduled | off
            "quality": "medium",        # high | medium | low | custom
            "crf": 23,
            "preset": "veryfast",
            "bitrate": "",
            "width": 0,
            "height": 0,
            "fps": 0,
            "segment_seconds": 300,
            "pre_seconds": 5,
            "post_seconds": 10,
            "max_event_seconds": 600,
            "codec": "copy",            # copy | h264
            "audio": False,
            "snapshot_on_motion": True,
            "retention_days": 0,
            "schedule": [],
        },
        "notifications": {
            "enabled": True,
            "cooldown_seconds": 60,
            "attach_snapshot": True,
            "telegram": {"enabled": False, "bot_token": "", "chat_id": ""},
            "ntfy": {
                "enabled": False,
                "server": "https://ntfy.sh",
                "topic": "",
                "token": "",
            },
            "webhook": {"enabled": False, "url": "", "headers": {}},
            "discord": {"enabled": False, "webhook_url": ""},
            "pushover": {"enabled": False, "app_token": "", "user_key": ""},
            "email": {
                "enabled": False,
                "host": "smtp.gmail.com",
                "port": 587,
                "starttls": True,
                "username": "",
                "password": "",
                "from": "",
                "to": "",
            },
        },
        "cameras": [],
    }


def _deep_merge(base: Dict[str, Any], new: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(base)
    for key, value in new.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


class Config:
    """Envuelve el dict de configuración con guardado atómico y thread-safe."""

    def __init__(self, path: Path = CONFIG_PATH):
        self.path = path
        self._lock = threading.RLock()
        self._data: Dict[str, Any] = {}
        self.load()

    # ---------- carga / guardado ----------
    def load(self) -> None:
        with self._lock:
            if self.path.exists():
                try:
                    raw = json.loads(self.path.read_text(encoding="utf-8"))
                except Exception:
                    backup = self.path.with_suffix(".corrupt.json")
                    try:
                        shutil.copy(self.path, backup)
                    except Exception:
                        pass
                    raw = {}
                self._data = _deep_merge(default_config(), raw)
            else:
                self._data = default_config()
            self.ensure_dirs()

    def save(self) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(
                json.dumps(self._data, indent=2, ensure_ascii=False), encoding="utf-8"
            )
            os.replace(tmp, self.path)

    # ---------- acceso ----------
    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return json.loads(json.dumps(self._data))

    @property
    def data(self) -> Dict[str, Any]:
        return self._data

    def section(self, name: str) -> Dict[str, Any]:
        with self._lock:
            return json.loads(json.dumps(self._data.get(name, {})))

    def update_section(self, name: str, patch: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            current = self._data.get(name, {})
            if not isinstance(current, dict):
                current = {}
            self._data[name] = _deep_merge(current, patch)
            self.ensure_dirs()
            snapshot = json.loads(json.dumps(self._data[name]))
        self.save()
        return snapshot

    def replace(self, new_data: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            self._data = _deep_merge(default_config(), new_data)
            self.ensure_dirs()
        self.save()
        return self.snapshot()

    # ---------- directorios ----------
    def ensure_dirs(self) -> None:
        storage = self._data.setdefault("storage", {})
        for key, fallback in (
            ("recordings_dir", DATA_DIR / RECORDINGS_DIRNAME),
            ("snapshots_dir", DATA_DIR / SNAPSHOTS_DIRNAME),
            ("clips_dir", DATA_DIR / CLIPS_DIRNAME),
        ):
            path = Path(storage.get(key) or fallback).expanduser()
            storage[key] = str(path)
            try:
                path.mkdir(parents=True, exist_ok=True)
            except Exception:
                pass
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass

    # ---------- cámaras ----------
    def cameras(self) -> list:
        with self._lock:
            return json.loads(json.dumps(self._data.get("cameras", [])))

    def get_camera(self, camera_id: str):
        with self._lock:
            for cam in self._data.get("cameras", []):
                if cam.get("id") == camera_id:
                    return json.loads(json.dumps(cam))
        return None

    def add_camera(self, camera: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            self._data.setdefault("cameras", []).append(camera)
        self.save()
        return camera

    def update_camera(self, camera_id: str, patch: Dict[str, Any]):
        with self._lock:
            for idx, cam in enumerate(self._data.get("cameras", [])):
                if cam.get("id") == camera_id:
                    merged = _deep_merge(cam, patch)
                    merged["id"] = camera_id
                    self._data["cameras"][idx] = merged
                    self.save()
                    return json.loads(json.dumps(merged))
        return None

    def remove_camera(self, camera_id: str) -> bool:
        with self._lock:
            cams = self._data.get("cameras", [])
            for idx, cam in enumerate(cams):
                if cam.get("id") == camera_id:
                    cams.pop(idx)
                    self.save()
                    return True
        return False


config = Config()

# ---------- rutas derivadas ----------


def recordings_dir() -> Path:
    return Path(config.data["storage"]["recordings_dir"])


def snapshots_dir() -> Path:
    return Path(config.data["storage"]["snapshots_dir"])


def clips_dir() -> Path:
    return Path(config.data["storage"]["clips_dir"])


def events_path() -> Path:
    return DATA_DIR / EVENTS_FILENAME
