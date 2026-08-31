"""Eventos detectados (movimiento, personas, vehículos...)."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Body, HTTPException, Query

from .. import events_store
from ..config import config
from ..media import placeholder_jpeg
from fastapi.responses import Response

router = APIRouter(prefix="/events", tags=["events"])


def _camera_name(camera_id: str) -> str:
    cam = config.get_camera(camera_id) or {}
    return cam.get("name", camera_id)


@router.get("")
def list_events(
    camera_id: Optional[str] = Query(None),
    label: Optional[str] = Query(None),
    since: Optional[str] = Query(None),
    until: Optional[str] = Query(None),
    unacknowledged: bool = Query(False),
    limit: int = Query(200, ge=1, le=2000),
):
    items = events_store.query(
        camera_id=camera_id,
        since=since,
        until=until,
        label=label,
        only_unack=unacknowledged,
        limit=limit,
    )
    cams = {c["id"]: c.get("name", "") for c in config.cameras()}
    for item in items:
        item["camera_name"] = cams.get(item.get("camera_id"), item.get("camera_name", ""))
    return {
        "events": items,
        "unacknowledged": events_store.count_unacknowledged(),
        "total": len(items),
    }


@router.get("/summary")
def summary():
    """Conteo por etiqueta y por día (últimos 14) para la vista de resumen."""
    items = events_store.all_events()
    by_label: dict = {}
    by_day: dict = {}
    for event in items:
        by_label[event.get("label", "motion")] = by_label.get(event.get("label", "motion"), 0) + 1
        day = (event.get("ts") or "")[:10]
        if day:
            by_day[day] = by_day.get(day, 0) + 1
    return {
        "total": len(items),
        "unacknowledged": events_store.count_unacknowledged(),
        "by_label": by_label,
        "by_day": dict(sorted(by_day.items(), reverse=True)[:14]),
    }


@router.get("/{event_id}")
def get_event(event_id: str):
    event = events_store.get(event_id)
    if not event:
        raise HTTPException(404, "Evento no encontrado")
    return {"event": event}


@router.post("/{event_id}/ack")
def acknowledge(event_id: str, value: bool = Body(True, embed=True)):
    event = events_store.update(event_id, {"acknowledged": bool(value)})
    if not event:
        raise HTTPException(404, "Evento no encontrado")
    return {"event": event}


@router.delete("/{event_id}")
def delete_event(event_id: str):
    if not events_store.delete(event_id):
        raise HTTPException(404, "Evento no encontrado")
    return {"ok": True}


@router.post("/clear")
def clear_events(camera_id: Optional[str] = Body(None, embed=True)):
    removed = events_store.clear(camera_id)
    return {"ok": True, "removed": removed}


@router.get("/{event_id}/snapshot.jpg")
def event_snapshot(event_id: str):
    from ..media import safe_media_path
    from fastapi.responses import FileResponse

    event = events_store.get(event_id)
    if not event or not event.get("snapshot"):
        return Response(content=placeholder_jpeg("Sin imagen"), media_type="image/jpeg")
    path = safe_media_path(event["snapshot"])
    if not path.exists():
        return Response(content=placeholder_jpeg("Sin imagen"), media_type="image/jpeg")
    return FileResponse(str(path), media_type="image/jpeg")
