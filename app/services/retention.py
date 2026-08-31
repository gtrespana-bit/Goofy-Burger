"""Retención y limpieza de grabaciones."""

from __future__ import annotations

import shutil
import time
from pathlib import Path
from typing import Dict, List, Tuple

from .. import events_store
from ..config import clips_dir, config, recordings_dir, snapshots_dir
from ..models import iso, utc_now
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


def storage_stats() -> Dict:
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

    for root in roots:
        for path in list(_iter_files(root)):
            try:
                st = path.stat()
            except Exception:
                continue
            if st.st_mtime < cutoff:
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

    return {**deleted, "events": removed_events}
