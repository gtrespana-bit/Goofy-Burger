"""Canales de notificación: Telegram, ntfy, webhook y email.

Los envíos se hacen en un pool de hilos para no bloquear el bucle de vídeo.
"""

from __future__ import annotations

import json
import mimetypes
import smtplib
import ssl
from concurrent.futures import ThreadPoolExecutor
from email.message import EmailMessage
from pathlib import Path
from typing import Dict, List, Optional

import requests

CHANNELS = ("telegram", "ntfy", "webhook", "discord", "pushover", "email")

_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="notifier")


def _send_telegram(cfg: dict, title: str, body: str, image: Optional[Path]) -> str:
    token = (cfg.get("bot_token") or "").strip()
    chat = (cfg.get("chat_id") or "").strip()
    if not token or not chat:
        return "telegram: falta bot_token o chat_id"
    base = f"https://api.telegram.org/bot{token}"
    try:
        if image and image.exists():
            with image.open("rb") as fh:
                files = {"photo": (image.name, fh, "image/jpeg")}
                data = {"chat_id": chat, "caption": f"{title}\n{body}"[:1024]}
                resp = requests.post(f"{base}/sendPhoto", data=data, files=files, timeout=15)
        else:
            payload = {
                "chat_id": chat,
                "text": f"*{title}*\n{body}",
                "parse_mode": "Markdown",
            }
            resp = requests.post(f"{base}/sendMessage", json=payload, timeout=15)
        if resp.status_code >= 300:
            return f"telegram: HTTP {resp.status_code} {resp.text[:120]}"
        return ""
    except Exception as exc:
        return f"telegram: {type(exc).__name__}: {exc}"


def _send_ntfy(cfg: dict, title: str, body: str, image: Optional[Path]) -> str:
    server = (cfg.get("server") or "https://ntfy.sh").rstrip("/")
    topic = (cfg.get("topic") or "").strip()
    if not topic:
        return "ntfy: falta topic"
    headers = {"Title": title, "Tags": "rotating_light"}
    token = (cfg.get("token") or "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        if image and image.exists():
            with image.open("rb") as fh:
                resp = requests.put(
                    f"{server}/{topic}",
                    data=fh,
                    headers={**headers, "Filename": image.name},
                    timeout=15,
                )
        else:
            resp = requests.post(
                f"{server}/{topic}", data=body.encode("utf-8"), headers=headers, timeout=15
            )
        if resp.status_code >= 300:
            return f"ntfy: HTTP {resp.status_code} {resp.text[:120]}"
        return ""
    except Exception as exc:
        return f"ntfy: {type(exc).__name__}: {exc}"


def _send_webhook(cfg: dict, title: str, body: str, image: Optional[Path]) -> str:
    url = (cfg.get("url") or "").strip()
    if not url:
        return "webhook: falta url"
    headers = dict(cfg.get("headers") or {})
    try:
        payload = {"title": title, "message": body, "text": f"{title}\n{body}"}
        if image and image.exists():
            with image.open("rb") as fh:
                files = {"file": (image.name, fh, "image/jpeg")}
                resp = requests.post(url, data=payload, files=files, headers=headers, timeout=15)
        else:
            resp = requests.post(url, json=payload, headers=headers, timeout=15)
        if resp.status_code >= 300:
            return f"webhook: HTTP {resp.status_code} {resp.text[:120]}"
        return ""
    except Exception as exc:
        return f"webhook: {type(exc).__name__}: {exc}"


def _send_discord(cfg: dict, title: str, body: str, image: Optional[Path]) -> str:
    url = (cfg.get("webhook_url") or "").strip()
    if not url:
        return "discord: falta webhook_url"
    payload = {"content": f"**{title}**\\n{body}"[:2000]}
    files = None
    data = None
    try:
        if image and image.exists():
            with image.open("rb") as fh:
                files = {"file": (image.name, fh, "image/jpeg")}
                data = {"payload_json": json.dumps(payload, ensure_ascii=False)}
                resp = requests.post(url, data=data, files=files, timeout=15)
        else:
            resp = requests.post(url, json=payload, timeout=15)
        if resp.status_code >= 300:
            return f"discord: HTTP {resp.status_code} {resp.text[:120]}"
        return ""
    except Exception as exc:
        return f"discord: {type(exc).__name__}: {exc}"


def _send_pushover(cfg: dict, title: str, body: str, image: Optional[Path]) -> str:
    token = (cfg.get("app_token") or "").strip()
    user = (cfg.get("user_key") or "").strip()
    if not token or not user:
        return "pushover: falta app_token o user_key"
    try:
        data = {"token": token, "user": user, "message": f"{title}\\n{body}"[:1024], "title": "Vigía"}
        if image and image.exists():
            with image.open("rb") as fh:
                resp = requests.post(
                    "https://api.pushover.net/1/messages.json",
                    data=data,
                    files={"attachment": (image.name, fh, "image/jpeg")},
                    timeout=15,
                )
        else:
            resp = requests.post(
                "https://api.pushover.net/1/messages.json", data=data, timeout=15
            )
        if resp.status_code >= 300:
            return f"pushover: HTTP {resp.status_code} {resp.text[:120]}"
        return ""
    except Exception as exc:
        return f"pushover: {type(exc).__name__}: {exc}"


def _send_email(cfg: dict, title: str, body: str, image: Optional[Path]) -> str:
    host = (cfg.get("host") or "").strip()
    to = (cfg.get("to") or "").strip()
    if not host or not to:
        return "email: falta host o destinatario"
    msg = EmailMessage()
    msg["Subject"] = title
    msg["From"] = cfg.get("from") or cfg.get("username") or "vigia@localhost"
    msg["To"] = to
    msg.set_content(body)
    if image and image.exists():
        ctype, _ = mimetypes.guess_type(str(image))
        maintype, subtype = (ctype or "image/jpeg").split("/", 1)
        msg.add_attachment(
            image.read_bytes(), maintype=maintype, subtype=subtype, filename=image.name
        )
    try:
        port = int(cfg.get("port") or 587)
        with smtplib.SMTP(host, port, timeout=20) as server:
            if cfg.get("starttls", True):
                server.starttls(context=ssl.create_default_context())
            if cfg.get("username"):
                server.login(cfg.get("username"), cfg.get("password") or "")
            server.send_message(msg)
        return ""
    except Exception as exc:
        return f"email: {type(exc).__name__}: {exc}"


_SENDERS = {
    "telegram": _send_telegram,
    "ntfy": _send_ntfy,
    "webhook": _send_webhook,
    "discord": _send_discord,
    "pushover": _send_pushover,
    "email": _send_email,
}


def active_channels(notif_cfg: dict, requested: Optional[List[str]] = None) -> List[str]:
    enabled = [c for c in CHANNELS if (notif_cfg.get(c) or {}).get("enabled")]
    if requested:
        return [c for c in enabled if c in requested]
    return enabled


class Notifier:
    def __init__(self, get_config):
        """``get_config`` devuelve el dict de configuración de notificaciones."""
        self._get_config = get_config
        self.last_errors: Dict[str, str] = {}

    def send(self, title: str, body: str, image: Optional[Path] = None,
             channels: Optional[List[str]] = None) -> Dict[str, str]:
        cfg = self._get_config() or {}
        if not cfg.get("enabled", True):
            return {"skipped": "notificaciones desactivadas"}
        targets = active_channels(cfg, channels)
        if not targets:
            return {"skipped": "ningún canal activo"}
        attach = image if cfg.get("attach_snapshot", True) else None
        results: Dict[str, str] = {}
        for name in targets:
            sender = _SENDERS.get(name)
            if not sender:
                continue
            try:
                err = sender(cfg.get(name) or {}, title, body, attach)
            except Exception as exc:  # pragma: no cover - defensivo
                err = f"{type(exc).__name__}: {exc}"
            results[name] = err or "ok"
            self.last_errors[name] = err
        return results

    def send_async(self, title: str, body: str, image: Optional[Path] = None,
                   channels: Optional[List[str]] = None):
        return _EXECUTOR.submit(self.send, title, body, image, channels)

    def test(self, channel: Optional[str] = None) -> Dict[str, str]:
        title = "🔔 Vigía: prueba"
        body = "Si lees esto, las notificaciones están bien configuradas."
        return self.send(title, body, None, [channel] if channel else None)
