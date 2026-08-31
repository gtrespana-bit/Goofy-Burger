"""Retención y limpieza de grabaciones."""

from __future__ import annotations

import shutil
import threading
import time
from pathlib import Path
from typing import Dict, List, Tuple

from .. import events_store
from ..config import clips_dir, config, recordings_dir, snapshots_dir
from ..models import iso, slugify, utc_now
from datetime import timedelta

VIDEO_EXT = {".mp4", ".mkv", ".ts", ".mov", ".m4v"}
IMG_EXT = {".jpg", ".jpeg", ".png", ".webp"}


def _iter_files(root: Path):
    if not root.exists():
        return
    for path in root.rglob("*"):
        if path.is_file():
            yield path


def dir_size(root: Path) -> Tuple[int, int]:
    total = 0
    count = 0
    for path in _iter_files(root):
        try:
            total += path.stat().st_size
            count += 1
        except Exception:
            continue
    return total, count


# El cálculo de almacenamiento recorre (y hace stat de) TODOS los ficheros de
# grabaciones/clips/instantáneas. Con grabación continua eso son miles de
# ficheros, así que no puede recalcularse en cada sondeo de la UI (cada 5 s)
# ni en cada petición de /system/info, /system/dashboard o /system/diagnostics.
# Lo cacheamos unos segundos: la UI responde al instante y el dato sigue siendo
# fresco. Las operaciones que borran ficheros invalidan la caché.
_STATS_CACHE: Dict = {"ts": 0.0, "value": None}
_STATS_LOCK = threading.Lock()
STATS_TTL = 15.0  # segundos


def _compute_storage_stats() -> Dict:
    rec_dir, clip_dir, snap_dir = recordings_dir(), clips_dir(), snapshots_dir()
    rec_size, rec_count = dir_size(rec_dir)
    clip_size, clip_count = dir_size(clip_dir)
    snap_size, snap_count = dir_size(snap_dir)
    try:
        usage = shutil.disk_usage(str(rec_dir))
        disk_total, disk_free = usage.total, usage.free
    except Exception:
        disk_total = disk_free = 0
    return {
        "recordings": {"bytes": rec_size, "files": rec_count, "dir": str(rec_dir)},
        "clips": {"bytes": clip_size, "files": clip_count, "dir": str(clip_dir)},
        "snapshots": {"bytes": snap_size, "files": snap_count, "dir": str(snap_dir)},
        "disk": {"total": disk_total, "free": disk_free},
    }


def storage_stats(force: bool = False) -> Dict:
    with _STATS_LOCK:
        now = time.time()
        cached = _STATS_CACHE.get("value")
        if not force and cached is not None and (now - _STATS_CACHE["ts"]) < STATS_TTL:
            return cached
        value = _compute_storage_stats()
        _STATS_CACHE["ts"] = now
        _STATS_CACHE["value"] = value
        return value


def invalidate_storage_cache() -> None:
    """Borra la caché de estadísticas (tras borrar grabaciones o podar)."""
    with _STATS_LOCK:
        _STATS_CACHE["ts"] = 0.0
        _STATS_CACHE["value"] = None


def prune(retention_days: int = None, max_gb: float = None,
          also_snapshots: bool = True) -> Dict:
    """Borra por antigüedad y, si sigue lleno, por espacio (los más viejos)."""
    cfg = config.section("storage")
    days = cfg.get("retention_days", 14) if retention_days is None else retention_days
    max_bytes = (
        float(cfg.get("max_storage_gb", 100) or 0) * 1024 ** 3
        if max_gb is None
        else float(max_gb) * 1024 ** 3
    )
    cutoff = time.time() - float(days) * 86400
    deleted = {"files": 0, "bytes": 0}
    roots = [recordings_dir(), clips_dir()]
    if also_snapshots:
        roots.append(snapshots_dir())

    # Retención propia por cámara: cada carpeta usa su recording.retention_days
    # si está configurado; si no, hereda la retención global.
    per_camera = {}
    for cam in config.cameras():
        own = int((cam.get("recording") or {}).get("retention_days", 0) or 0)
        if own:
            per_camera[slugify(cam.get("id", ""))] = own

    for root in roots:
        for path in list(_iter_files(root)):
            try:
                st = path.stat()
            except Exception:
                continue
            rel = path.relative_to(root)
            cam_slug = rel.parts[0] if rel.parts else ""
            own_days = per_camera.get(cam_slug)
            local_cutoff = cutoff
            if own_days:
                local_cutoff = time.time() - float(own_days) * 86400
            if st.st_mtime < local_cutoff:
                try:
                    path.unlink()
                    deleted["files"] += 1
                    deleted["bytes"] += st.st_size
                except Exception:
                    pass

    # Segundo paso: si nos pasamos del límite, borra lo más antiguo
    if max_bytes > 0:
        candidates: List[Tuple[float, int, Path]] = []
        for root in roots:
            for path in _iter_files(root):
                try:
                    st = path.stat()
                    candidates.append((st.st_mtime, st.st_size, path))
                except Exception:
                    continue
        total = sum(size for _, size, _ in candidates)
        if total > max_bytes:
            candidates.sort()
            for mtime, size, path in candidates:
                if total <= max_bytes:
                    break
                try:
                    path.unlink()
                    total -= size
                    deleted["files"] += 1
                    deleted["bytes"] += size
                except Exception:
                    continue

    # Eventos huérfanos en el JSON
    cutoff_iso = iso(utc_now() - timedelta(days=float(days)))
    removed_events = events_store.prune_older_than(cutoff_iso)

    # Limpieza de carpetas vacías
    for root in roots:
        if not root.exists():
            continue
        for folder in sorted(root.rglob("*"), key=lambda p: len(p.parts), reverse=True):
            try:
                if folder.is_dir() and not any(folder.iterdir()):
                    folder.rmdir()
            except Exception:
                continue

    if deleted["files"]:
        invalidate_storage_cache()
    return {**deleted, "events": removed_events}
