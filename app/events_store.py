"""Almacén de eventos en JSON (append + reescritura atómica)."""

from __future__ import annotations

import json
import os
import threading

from typing import Any, Dict, List, Optional

from .config import DATA_DIR, events_path
from .models import iso, utc_now

_LOCK = threading.RLock()
_CACHE: Optional[List[Dict[str, Any]]] = None
MAX_EVENTS = 20000


def _load() -> List[Dict[str, Any]]:
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    path = events_path()
    items: List[Dict[str, Any]] = []
    if path.exists():
        try:
            items = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(items, list):
                items = []
        except Exception:
            items = []
    _CACHE = items
    return _CACHE


def _persist(items: List[Dict[str, Any]]) -> None:
    path = events_path()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def add(event: Dict[str, Any]) -> Dict[str, Any]:
    with _LOCK:
        items = _load()
        items.append(event)
        if len(items) > MAX_EVENTS:
            items = items[-MAX_EVENTS:]
        _persist(items)
    return event


def all_events() -> List[Dict[str, Any]]:
    with _LOCK:
        return list(_load())


def query(
    camera_id: Optional[str] = None,
    since: Optional[str] = None,
    until: Optional[str] = None,
    label: Optional[str] = None,
    only_unack: bool = False,
    limit: int = 500,
) -> List[Dict[str, Any]]:
    with _LOCK:
        items = list(_load())
    if camera_id:
        items = [e for e in items if e.get("camera_id") == camera_id]
    if label:
        items = [e for e in items if e.get("label") == label]
    if since:
        items = [e for e in items if (e.get("ts") or "") >= since]
    if until:
        items = [e for e in items if (e.get("ts") or "") <= until]
    if only_unack:
        items = [e for e in items if not e.get("acknowledged")]
    items.sort(key=lambda e: e.get("ts", ""), reverse=True)
    return items[:limit]


def get(event_id: str) -> Optional[Dict[str, Any]]:
    with _LOCK:
        for e in _load():
            if e.get("id") == event_id:
                return e
    return None


def update(event_id: str, patch: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    with _LOCK:
        items = _load()
        for idx, e in enumerate(items):
            if e.get("id") == event_id:
                merged = {**e, **patch}
                merged["id"] = event_id
                items[idx] = merged
                _persist(items)
                return merged
    return None


def delete(event_id: str) -> bool:
    with _LOCK:
        items = _load()
        for idx, e in enumerate(items):
            if e.get("id") == event_id:
                items.pop(idx)
                _persist(items)
                return True
    return False


def clear(camera_id: Optional[str] = None) -> int:
    with _LOCK:
        items = _load()
        if camera_id:
            keep = [e for e in items if e.get("camera_id") != camera_id]
            removed = len(items) - len(keep)
        else:
            removed = len(items)
            keep = []
        _persist(keep)
    return removed


def prune_older_than(cutoff_iso: str) -> int:
    with _LOCK:
        items = _load()
        keep = [e for e in items if (e.get("ts") or "") >= cutoff_iso]
        removed = len(items) - len(keep)
        if removed:
            _persist(keep)
        return removed


def count_unacknowledged() -> int:
    with _LOCK:
        return sum(1 for e in _load() if not e.get("acknowledged"))


def make_event(
    camera: Dict[str, Any],
    label: str,
    score: float,
    boxes: List[List[int]],
    snapshot_rel: str = "",
    clip_rel: str = "",
    meta: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    return {
        "id": f"evt_{utc_now().strftime('%Y%m%d%H%M%S')}_{os.urandom(3).hex()}",
        "camera_id": camera.get("id"),
        "camera_name": camera.get("name", ""),
        "ts": iso(utc_now()),
        "label": label,
        "score": round(float(score), 3),
        "boxes": boxes,
        "snapshot": snapshot_rel,
        "clip": clip_rel,
        "notified": [],
        "acknowledged": False,
        "notes": "",
        "meta": meta or {},
    }
