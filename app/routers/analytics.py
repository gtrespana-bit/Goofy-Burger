"""Informes y estadísticas de analítica (Fase 3)."""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Query

from .. import events_store
from ..config import config

router = APIRouter(prefix="/analytics", tags=["analytics"])


def _last_week_dates(end: Optional[str] = None):
    try:
        if end:
            last = datetime.fromisoformat(str(end))
            last = last.replace(tzinfo=last.tzinfo or timezone.utc)
        else:
            last = datetime.now(timezone.utc)
    except Exception:
        last = datetime.now(timezone.utc)
    days = [(last - timedelta(days=i)).date().isoformat() for i in range(6, -1, -1)]
    return days[0], days[-1]


@router.get("/stats")
def stats():
    """Estado actual de la analítica por cámara (tracks en vivo)."""
    items = []
    from ..services.manager import manager

    for cam in config.cameras():
        st = manager.status(cam.get("id", ""))
        items.append({
            "camera_id": cam.get("id"),
            "name": cam.get("name", ""),
            "ai_enabled": bool((cam.get("detection") or {}).get("ai_enabled")),
            "analytics_enabled": bool((cam.get("detection") or {}).get("analytics", {}).get("enabled")),
            "lines": len((cam.get("detection") or {}).get("analytics", {}).get("lines") or []),
            "tracks": st.get("tracks", 0) if st else 0,
            "state": st.get("state", "stopped") if st else "stopped",
        })
    return {"cameras": items}


@router.get("/report/weekly")
def weekly_report(date: Optional[str] = Query(None), camera_id: Optional[str] = Query(None)):
    start, end = _last_week_dates(date)
    since = f"{start}T00:00:00Z"
    until = f"{end}T23:59:59Z"
    events = events_store.query(since=since, until=until, limit=100000)

    by_day = Counter()
    by_camera = Counter()
    by_label = Counter()
    unack = 0
    lines = defaultdict(Counter)
    days: dict = {}

    if camera_id:
        events = [e for e in events if e.get("camera_id") == camera_id]

    for ev in events:
        day = (ev.get("ts") or "")[:10]
        label = ev.get("label", "motion")
        by_day[day] += 1
        by_camera[ev.get("camera_name") or ev.get("camera_id") or "?"] += 1
        by_label[label] += 1
        if not ev.get("acknowledged"):
            unack += 1
        meta = ev.get("meta") or {}
        if label == "line_cross":
            line_name = meta.get("line_name") or meta.get("line_id") or "?"
            lines[line_name][meta.get("label", "object")] += 1
            if day:
                days.setdefault(day, {}).setdefault("line_crosses", 0)
                days[day]["line_crosses"] += 1

    day_rows = []
    for offset in range(7):
        day = (datetime.fromisoformat(start) + timedelta(days=offset)).date().isoformat()
        day_rows.append({
            "date": day,
            "total": by_day.get(day, 0),
            "line_crosses": (days.get(day, {}) or {}).get("line_crosses", 0),
        })

    return {
        "period": {"start": start, "end": end},
        "total": len(events),
        "unacknowledged": unack,
        "by_day": dict(sorted(by_day.items())),
        "by_camera": dict(by_camera.most_common()),
        "by_label": dict(by_label.most_common()),
        "line_crosses": {
            "total": sum(sum(c.values()) for c in lines.values()),
            "by_line": {k: dict(v.most_common()) for k, v in lines.items()},
        },
        "days": day_rows,
        "top_cameras": [{"name": k, "count": v} for k, v in by_camera.most_common(5)],
        "top_labels": [{"label": k, "count": v} for k, v in by_label.most_common(5)],
    }
