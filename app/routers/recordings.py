"""Explorador de grabaciones: listado, miniaturas, reproducción y limpieza."""

from __future__ import annotations

import hashlib
import re
import subprocess
import threading
import time

from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional

import cv2
from fastapi import APIRouter, Body, HTTPException, Query, Request

from ..config import DATA_DIR, clips_dir, config, recordings_dir
from ..media import placeholder_jpeg, range_file_response, safe_media_path
from ..models import slugify
from ..services.manager import manager
from ..services.recorder import ffmpeg_path
from ..services.retention import invalidate_storage_cache, storage_stats

router = APIRouter(prefix="/recordings", tags=["recordings"])

TS_RE = re.compile(r"(?:clip_(?P<cam>[A-Za-z0-9_-]+)_)?(?P<ts>\d{8}T\d{6})")
THUMB_DIR = DATA_DIR / "thumbs"


def _camera_index() -> Dict[str, dict]:
    return {slugify(cam["id"]): cam for cam in config.cameras()}


def _scan_dir(base: Path, kind: str, cams: Dict[str, dict]) -> List[dict]:
    items: List[dict] = []
    if not base.exists():
        return items
    for folder in sorted(p for p in base.iterdir() if p.is_dir()):
        cam = cams.get(folder.name)
        camera_id = cam["id"] if cam else folder.name
        camera_name = cam["name"] if cam else folder.name
        for path in folder.rglob("*.mp4"):
            try:
                stat = path.stat()
            except Exception:
                continue
            match = TS_RE.search(path.name)
            if match:
                try:
                    start_dt = datetime.strptime(match.group("ts"), "%Y%m%dT%H%M%S")
                except ValueError:
                    start_dt = datetime.fromtimestamp(stat.st_mtime)
            else:
                start_dt = datetime.fromtimestamp(stat.st_mtime)
            start_ts = start_dt.timestamp()
            end_ts = stat.st_mtime
            try:
                rel = str(path.resolve().relative_to(DATA_DIR.resolve()))
            except Exception:
                rel = str(path)
            items.append(
                {
                    "id": rel,
                    "path": rel,
                    "name": path.name,
                    "camera_id": camera_id,
                    "camera_name": camera_name,
                    "kind": kind,
                    "start": start_dt.replace(microsecond=0).isoformat() + "Z",
                    "end": datetime.fromtimestamp(end_ts).replace(microsecond=0).isoformat() + "Z",
                    "start_ts": start_ts,
                    "end_ts": end_ts,
                    "duration": max(0, int(end_ts - start_ts)),
                    "size": stat.st_size,
                }
            )
    return items


# La vista de grabaciones dispara 3 peticiones a la vez (listado, calendario y
# timeline) y cada una recorría TODO el árbol de ficheros haciendo stat(). Con
# años de grabación continua eso son cientos de miles de ficheros: cacheamos el
# escaneo unos segundos para que las 3 peticiones compartan un único recorrido
# y las visitas seguidas a la pestaña respondan al instante.
_COLLECT_CACHE: Dict = {"ts": 0.0, "value": None}
_COLLECT_LOCK = threading.Lock()
COLLECT_TTL = 5.0


def invalidate_collect_cache() -> None:
    with _COLLECT_LOCK:
        _COLLECT_CACHE["ts"] = 0.0
        _COLLECT_CACHE["value"] = None


def collect(camera_id: Optional[str] = None, kind: Optional[str] = None) -> List[dict]:
    with _COLLECT_LOCK:
        now = time.time()
        items = _COLLECT_CACHE.get("value")
        if items is None or (now - _COLLECT_CACHE["ts"]) >= COLLECT_TTL:
            cams = _camera_index()
            items = _scan_dir(recordings_dir(), "segment", cams) + _scan_dir(
                clips_dir(), "clip", cams
            )
            items.sort(key=lambda i: i["start_ts"], reverse=True)
            _COLLECT_CACHE["ts"] = now
            _COLLECT_CACHE["value"] = items
    if camera_id:
        items = [i for i in items if i["camera_id"] == camera_id]
    if kind:
        items = [i for i in items if i["kind"] == kind]
    return items


@router.get("")
def list_recordings(
    camera_id: Optional[str] = Query(None),
    date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    kind: Optional[str] = Query(None),
    limit: int = Query(300, ge=1, le=5000),
    offset: int = Query(0, ge=0),
):
    items = collect(camera_id, kind)
    if date:
        items = [i for i in items if i["start"][:10] == date]
    total = len(items)
    return {
        "total": total,
        "items": items[offset : offset + limit],
        "storage": storage_stats(),
    }


@router.get("/timeline")
def timeline(camera_id: Optional[str] = None, date: Optional[str] = None):
    """Línea de tiempo de un día: grabaciones (continua/clips) + eventos."""
    from datetime import datetime

    if not date:
        date = datetime.utcnow().strftime("%Y-%m-%d")
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except Exception:
        raise HTTPException(400, "Fecha inválida (YYYY-MM-DD)")
    items = collect(camera_id)
    items = [i for i in items if i["start"][:10] == date]
    since = f"{date}T00:00:00Z"
    until = f"{date}T23:59:59Z"
    from .. import events_store
    events = events_store.query(since=since, until=until, limit=1000)
    if camera_id:
        events = [e for e in events if e.get("camera_id") == camera_id]
    return {
        "date": date,
        "items": items,
        "events": events,
        "storage": storage_stats(),
    }
@router.get("/calendar")
def calendar(camera_id: Optional[str] = None, days: int = Query(31, ge=1, le=365)):
    """Resumen por día para pintar el calendario/línea de tiempo."""
    items = collect(camera_id)
    cutoff = (datetime.utcnow() - timedelta(days=days)).timestamp()
    buckets: Dict[str, dict] = {}
    for item in items:
        if item["start_ts"] < cutoff:
            continue
        day = item["start"][:10]
        bucket = buckets.setdefault(day, {"date": day, "segments": 0, "clips": 0, "bytes": 0})
        bucket["segments" if item["kind"] == "segment" else "clips"] += 1
        bucket["bytes"] += item["size"]
    return {"days": sorted(buckets.values(), key=lambda b: b["date"], reverse=True)}


@router.get("/stats")
def stats():
    return storage_stats()


@router.post("/prune")
def prune_now(payload: dict = Body(default={})):
    result = manager.prune_now()
    return {"ok": True, **result}


@router.get("/play")
def play(path: str = Query(...), request: Request = None):
    file_path = safe_media_path(path)
    return range_file_response(file_path, request)


@router.get("/download")
def download(path: str = Query(...), request: Request = None):
    file_path = safe_media_path(path)
    return range_file_response(file_path, request, download=True)


@router.get("/thumb")
def thumbnail(path: str = Query(...), second: float = Query(1.0)):
    """Miniatura del vídeo, generada con ffmpeg y cacheada en disco."""
    file_path = safe_media_path(path)
    if not file_path.exists():
        raise HTTPException(404, "No encontrado")
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    key = hashlib.md5(f"{path}:{second}".encode()).hexdigest()[:16]
    thumb = THUMB_DIR / f"{key}.jpg"
    if not thumb.exists():
        exe = ffmpeg_path()
        ok = False
        if exe:
            try:
                subprocess.run(
                    [
                        exe, "-hide_banner", "-loglevel", "error", "-y",
                        "-ss", str(max(0.0, second)), "-i", str(file_path),
                        "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4",
                        str(thumb),
                    ],
                    timeout=25,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                ok = thumb.exists() and thumb.stat().st_size > 500
            except Exception:
                ok = False
        if not ok:  # fallback con OpenCV
            cap = cv2.VideoCapture(str(file_path))
            try:
                cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, second) * 1000)
                success, frame = cap.read()
                if success and frame is not None:
                    h, w = frame.shape[:2]
                    scale = 480.0 / w
                    small = cv2.resize(frame, (480, int(h * scale)))
                    cv2.imwrite(str(thumb), small, [int(cv2.IMWRITE_JPEG_QUALITY), 72])
                    ok = True
            finally:
                cap.release()
        if not ok:
            # Vídeo aún en curso o ilegible: devolvemos un marcador en vez de un 500
            from fastapi.responses import Response

            return Response(
                content=placeholder_jpeg("Grabando…"),
                media_type="image/jpeg",
                headers={"Cache-Control": "no-store"},
            )
    from fastapi.responses import FileResponse

    return FileResponse(str(thumb), media_type="image/jpeg")


@router.delete("")
def delete_recording(path: str = Query(...)):
    file_path = safe_media_path(path)
    if not file_path.exists():
        raise HTTPException(404, "No encontrado")
    try:
        file_path.unlink()
    except Exception as exc:
        raise HTTPException(500, f"No se pudo borrar: {exc}")
    invalidate_storage_cache()
    invalidate_collect_cache()
    return {"ok": True}


@router.delete("/camera/{camera_id}")
def delete_camera_recordings(camera_id: str, kind: Optional[str] = None):
    """Borra todas las grabaciones de una cámara (o sólo clips/segments)."""
    import shutil

    slug = slugify(camera_id)
    removed = 0
    bases = []
    if kind in (None, "segment"):
        bases.append(recordings_dir() / slug)
    if kind in (None, "clip"):
        bases.append(clips_dir() / slug)
    for base in bases:
        if not base.exists():
            continue
        for path in list(base.rglob("*.mp4")):
            try:
                path.unlink()
                removed += 1
            except Exception:
                continue
        try:
            shutil.rmtree(base, ignore_errors=True)
        except Exception:
            pass
    if removed:
        invalidate_storage_cache()
        invalidate_collect_cache()
    return {"ok": True, "removed": removed}
