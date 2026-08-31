"""Configuración general y notificaciones."""

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, HTTPException

from ..auth import hash_password
from ..config import config
from ..services.manager import manager

router = APIRouter(prefix="/settings", tags=["settings"])

UPDATABLE = ("general", "storage", "detection", "recording", "notifications")


@router.get("")
def get_settings():
    data = config.snapshot()
    data["_meta"] = {
        "updatable_sections": list(UPDATABLE),
        "data_dir": str(config.path.parent),
    }
    return data


@router.patch("/{section}")
def patch_section(section: str, patch: Dict[str, Any] = Body(...)):
    if section not in UPDATABLE:
        raise HTTPException(400, f"Sección no editable: {section}")
    if "password" in patch and isinstance(patch.get("password"), str) and patch["password"]:
        raw = patch.pop("password")
        patch["password_hash"] = hash_password(raw)
    section_data = config.update_section(section, patch)
    if section in ("detection", "recording"):
        manager.sync(config.cameras())
    return {"section": section, "data": section_data}


@router.put("")
def replace_settings(payload: Dict[str, Any] = Body(...)):
    data = config.replace(payload)
    manager.sync(config.cameras())
    return data


@router.post("/notifications/test")
def test_notifications(channel: Optional[str] = Body(None, embed=True)):
    result = manager.notifier.test(channel)
    return {"results": result}


@router.post("/reload")
def reload_config():
    config.load()
    manager.sync(config.cameras())
    return {"ok": True}


@router.post("/export")
def export_config():
    """Devuelve la configuración (sin contraseñas) para copia de seguridad."""
    import copy
    import json

    data = copy.deepcopy(config.snapshot())
    for cam in data.get("cameras", []):
        cam["password"] = ""
        if cam.get("onvif"):
            cam["onvif"]["password"] = ""
    notif = data.get("notifications", {})
    if notif.get("email"):
        notif["email"]["password"] = ""
    if notif.get("telegram"):
        notif["telegram"]["bot_token"] = ""
    return data


@router.post("/import")
def import_config(payload: Dict[str, Any] = Body(...)):
    data = config.replace(payload)
    manager.sync(config.cameras())
    return {"ok": True, "cameras": len(data.get("cameras", []))}
