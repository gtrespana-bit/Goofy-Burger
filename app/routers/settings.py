"""Configuración general y notificaciones."""

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, HTTPException

from ..auth import api_tokens, generate_totp_secret, hash_password, hash_token, users, verify_totp
from ..config import clips_dir, config, recordings_dir, snapshots_dir
from ..services.manager import manager

router = APIRouter(prefix="/settings", tags=["settings"])

UPDATABLE = ("general", "storage", "detection", "recording", "notifications")


@router.get("")
def get_settings():
    data = config.snapshot()
    data.pop("push", None)  # claves VAPID y suscripciones privadas
    data["_meta"] = {
        "updatable_sections": list(UPDATABLE),
        "data_dir": str(config.path.parent),
    }
    return data


@router.get("/auth/status")
def auth_status():
    data = config.snapshot()
    general = data.get("general", {})
    return {
        "auth_enabled": general.get("auth_enabled", False),
        "username": general.get("username", "admin"),
        "users": [
            {
                "username": u.get("username", ""),
                "name": u.get("name", u.get("username", "")),
                "role": u.get("role", "admin"),
                "totp_enabled": bool(u.get("totp_enabled")),
                "totp_secret": u.get("totp_secret", ""),
            }
            for u in users()
        ],
        "api_tokens": [
            {
                "name": t.get("name", ""),
                "role": t.get("role", "admin"),
                "prefix": (t.get("token_hash", "") or "")[:12],
                "created_at": t.get("created_at", ""),
            }
            for t in api_tokens()
            if not t.get("session")
        ],
        "remote": general.get("remote", {}),
    }


@router.post("/auth/users")
def upsert_user(payload: Dict[str, Any] = Body(...)):
    from ..auth import ROLES

    username = str(payload.get("username") or "").strip()
    name = str(payload.get("name") or username)
    role = str(payload.get("role") or "viewer")
    if not username:
        raise HTTPException(400, "Falta el nombre de usuario")
    if role not in ROLES:
        raise HTTPException(400, f"Rol inválido: {role}")
    general = config.section("general")
    current = list(general.get("users") or [])
    idx = next((i for i, u in enumerate(current) if u.get("username") == username), None)
    password = str(payload.get("password") or "")
    if idx is None:
        if not password:
            raise HTTPException(400, "La contraseña es obligatoria para un usuario nuevo")
        user = {
            "username": username,
            "name": name,
            "role": role,
            "password_hash": hash_password(password),
            "totp_secret": payload.get("totp_secret") or "",
            "totp_enabled": bool(payload.get("totp_enabled")),
        }
        current.append(user)
    else:
        user = dict(current[idx])
        user.update({
            "name": name,
            "role": role,
            "totp_enabled": bool(payload.get("totp_enabled", user.get("totp_enabled"))),
        })
        if payload.get("totp_secret"):
            user["totp_secret"] = payload["totp_secret"]
        if password:
            user["password_hash"] = hash_password(password)
        current[idx] = user
    config.update_section("general", {"users": current})
    return {"ok": True, "users": len(current)}


@router.delete("/auth/users/{username}")
def delete_user(username: str):
    general = config.section("general")
    current = [u for u in general.get("users") or [] if u.get("username") != username]
    if len(current) == len(general.get("users") or []):
        raise HTTPException(404, "Usuario no encontrado")
    config.update_section("general", {"users": current})
    return {"ok": True}


@router.post("/auth/tokens")
def create_token(payload: Dict[str, Any] = Body(...)):
    import secrets as _secrets
    from datetime import datetime, timezone

    name = str(payload.get("name") or "").strip()
    role = str(payload.get("role") or "admin")
    if not name:
        raise HTTPException(400, "Falta el nombre del token")
    if role not in ("admin", "viewer"):
        raise HTTPException(400, f"Rol inválido: {role}")
    token = _secrets.token_urlsafe(24)
    general = config.section("general")
    tokens = list(general.get("api_tokens") or [])
    tokens = [t for t in tokens if t.get("name") != name]
    tokens.append({
        "name": name,
        "role": role,
        "token_hash": hash_token(token),
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    config.update_section("general", {"api_tokens": tokens})
    return {"ok": True, "token": token, "name": name, "role": role}


@router.delete("/auth/tokens/{name}")
def delete_token(name: str):
    general = config.section("general")
    tokens = [t for t in general.get("api_tokens") or [] if t.get("name") != name]
    if len(tokens) == len(general.get("api_tokens") or []):
        raise HTTPException(404, "Token no encontrado")
    config.update_section("general", {"api_tokens": tokens})
    return {"ok": True}


@router.post("/auth/2fa/new")
def new_2fa_secret(payload: Dict[str, Any] = Body(default={})):
    username = str(payload.get("username") or "").strip()
    secret = generate_totp_secret()
    general = config.section("general")
    current = list(general.get("users") or [])
    idx = next((i for i, u in enumerate(current) if u.get("username") == username), None)
    if idx is None:
        raise HTTPException(404, "Usuario no encontrado")
    current[idx] = {**current[idx], "totp_secret": secret}
    config.update_section("general", {"users": current})
    return {"ok": True, "secret": secret}


@router.post("/auth/2fa/verify")
def verify_2fa(payload: Dict[str, Any] = Body(...)):
    username = str(payload.get("username") or "").strip()
    code = str(payload.get("code") or "")
    secret = str(payload.get("secret") or "")
    if not secret or not verify_totp(secret, code):
        raise HTTPException(400, "Código TOTP incorrecto")
    return {"ok": True}


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


@router.post("/factory-reset")
def factory_reset(payload: Dict[str, Any] = Body(default={})):
    """Restablece todos los ajustes a los valores de fábrica.

    Opcionalmente borra también grabaciones, clips e instantáneas. Los
    directorios de datos se dejan creados para que la app siga funcionando.
    """
    import shutil

    wipe = bool(payload.get("wipe_recordings"))
    manager.stop_all()
    if wipe:
        for base in (recordings_dir(), clips_dir(), snapshots_dir()):
            try:
                if base.exists():
                    shutil.rmtree(str(base))
                base.mkdir(parents=True, exist_ok=True)
            except Exception:
                pass
        from ..services.retention import invalidate_storage_cache

        invalidate_storage_cache()
    config.reset()
    manager.sync([])
    return {"ok": True, "cameras": 0, "auth_enabled": False}


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
    data.pop("push", None)  # claves VAPID y suscripciones: no se exportan
    general = data.setdefault("general", {})
    general.pop("password_hash", None)
    for user in general.get("users", []):
        user.pop("password_hash", None)
    for tok in general.get("api_tokens", []):
        tok.pop("token_hash", None)
    for cam in data.get("cameras", []):
        cam["password"] = ""
        if cam.get("onvif"):
            cam["onvif"]["password"] = ""
    notif = data.get("notifications", {})
    if notif.get("email"):
        notif["email"]["password"] = ""
    if notif.get("telegram"):
        notif["telegram"]["bot_token"] = ""
    if notif.get("discord"):
        notif["discord"]["webhook_url"] = ""
    if notif.get("pushover"):
        notif["pushover"]["app_token"] = ""
    return data


@router.post("/import")
def import_config(payload: Dict[str, Any] = Body(...)):
    data = config.replace(payload)
    manager.sync(config.cameras())
    return {"ok": True, "cameras": len(data.get("cameras", []))}
