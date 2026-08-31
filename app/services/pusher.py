"""Servicio de notificaciones push web (Web Push / VAPID)."""

from __future__ import annotations

import base64
import json
import time
from typing import Any, Dict, List
from urllib.parse import urlparse

from ..config import config

try:
    from pywebpush import WebPushException, webpush  # type: ignore

    PUSH_AVAILABLE = True
    PUSH_ERROR = ""
except Exception as exc:  # pragma: no cover
    webpush = None
    WebPushException = Exception
    PUSH_AVAILABLE = False
    PUSH_ERROR = str(exc)


def available() -> bool:
    global PUSH_AVAILABLE, PUSH_ERROR
    try:
        import pywebpush  # noqa: F401
        PUSH_AVAILABLE = True
        PUSH_ERROR = ""
        return True
    except Exception as exc:
        PUSH_AVAILABLE = False
        PUSH_ERROR = str(exc)
        return False


def generate_vapid():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    priv = ec.generate_private_key(ec.SECP256R1())
    pub = priv.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    private_pem = priv.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode("utf-8")
    public_b64 = base64.urlsafe_b64encode(pub).rstrip(b"=").decode("ascii")
    return {"vapid_private_key": private_pem, "vapid_public_key": public_b64}


def push_cfg() -> Dict[str, Any]:
    return config.section("push")


def subscriptions() -> List[Dict[str, Any]]:
    return list(push_cfg().get("subscriptions") or [])


def keys_ready() -> bool:
    cfg = push_cfg()
    return bool(cfg.get("vapid_public_key") and cfg.get("vapid_private_key"))


def send_push(title: str, body: str, url: str = "/") -> Dict[str, Any]:
    """Envía una notificación a todas las suscripciones guardadas."""
    cfg = push_cfg()
    if not cfg.get("enabled"):
        return {"ok": False, "error": "push desactivado", "sent": 0}
    if not available():
        return {"ok": False, "error": "pywebpush no está instalado", "sent": 0}
    if not keys_ready():
        return {"ok": False, "error": "claves VAPID no configuradas", "sent": 0}
    subs = subscriptions()
    if not subs:
        return {"ok": True, "sent": 0}
    subject = cfg.get("vapid_subject", "mailto:admin@vigia.local")
    payload = json.dumps({"title": title, "body": body, "url": url})
    results = []
    remaining = []
    for sub in subs:
        endpoint = str(sub.get("endpoint") or "")
        try:
            origin = urlparse(endpoint)
            aud = f"{origin.scheme}://{origin.netloc}"
            webpush(
                subscription_info=sub,
                data=payload,
                vapid_private_key=cfg.get("vapid_private_key", ""),
                vapid_claims={
                    "sub": subject,
                    "aud": aud,
                    "exp": int(time.time()) + 12 * 3600,
                },
                ttl=3600,
                timeout=10,
            )
            remaining.append(sub)
            results.append({"endpoint": endpoint, "ok": True})
        except WebPushException as exc:
            status = getattr(exc, "response", None)
            code = getattr(status, "status_code", None) if status is not None else None
            if code in (404, 410, 403):
                results.append({"endpoint": endpoint, "ok": False, "expired": True})
                continue
            remaining.append(sub)
            results.append({"endpoint": endpoint, "ok": False, "error": str(exc)})
        except Exception as exc:
            remaining.append(sub)
            results.append({"endpoint": endpoint, "ok": False, "error": str(exc)})
    config.update_section("push", {"subscriptions": remaining})
    return {
        "ok": True,
        "sent": sum(1 for r in results if r.get("ok")),
        "failed": sum(1 for r in results if not r.get("ok") and not r.get("expired")),
        "expired": sum(1 for r in results if r.get("expired")),
    }
