"""API de push web: estado, claves VAPID, suscripciones y prueba."""

from __future__ import annotations

import time
from typing import Any, Dict

from fastapi import APIRouter, Body, HTTPException

from ..config import config
from ..services.pusher import PUSH_ERROR, available, generate_vapid, keys_ready, push_cfg, send_push

router = APIRouter(prefix="/push", tags=["push"])


@router.get("/status")
def status():
    cfg = push_cfg()
    return {
        "available": available(),
        "error": "" if available() else PUSH_ERROR,
        "enabled": bool(cfg.get("enabled")),
        "public_key": cfg.get("vapid_public_key", ""),
        "subscriptions": len(cfg.get("subscriptions") or []),
        "subject": cfg.get("vapid_subject", ""),
        "hint": "Para recibir push en el móvil, instala la PWA y usa HTTPS/Tailscale.",
    }


@router.post("/setup")
def setup():
    """Genera las claves VAPID y activa el push para suscribirse desde la web."""
    if not available():
        raise HTTPException(400, "pywebpush no está instalado. Ejecuta: pip install pywebpush")
    cfg = push_cfg()
    patch: Dict[str, Any] = {"enabled": True}
    if not cfg.get("vapid_public_key") or not cfg.get("vapid_private_key"):
        patch.update(generate_vapid())
    config.update_section("push", patch)
    cfg = push_cfg()
    return {
        "ok": True,
        "public_key": cfg.get("vapid_public_key", ""),
        "subscriptions": len(cfg.get("subscriptions") or []),
    }


@router.post("/subscribe")
def subscribe(payload: Dict[str, Any] = Body(...)):
    sub = payload.get("subscription") or payload
    endpoint = str(sub.get("endpoint") or "").strip()
    if not endpoint:
        raise HTTPException(400, "Falta el endpoint de la suscripción")
    keys = sub.get("keys") or {}
    cfg = push_cfg()
    subs = [s for s in list(cfg.get("subscriptions") or []) if s.get("endpoint") != endpoint]
    subs.append({
        "endpoint": endpoint,
        "keys": {"p256dh": keys.get("p256dh", ""), "auth": keys.get("auth", "")},
        "user_agent": str(payload.get("user_agent") or "")[:200],
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
    })
    config.update_section("push", {"subscriptions": subs, "enabled": True})
    return {"ok": True, "subscriptions": len(subs)}


@router.post("/unsubscribe")
def unsubscribe(payload: Dict[str, Any] = Body(default={})):
    endpoint = str(payload.get("endpoint") or "")
    cfg = push_cfg()
    subs = [s for s in list(cfg.get("subscriptions") or []) if s.get("endpoint") != endpoint]
    config.update_section("push", {"subscriptions": subs})
    return {"ok": True, "subscriptions": len(subs)}


@router.post("/test")
def test():
    if not keys_ready():
        raise HTTPException(400, "Configura primero el push en Ajustes → Notificaciones.")
    if not available():
        raise HTTPException(400, "pywebpush no está instalado. Ejecuta: pip install pywebpush")
    return send_push("🔔 Vigía Pro", "Prueba de notificación push", "/")
