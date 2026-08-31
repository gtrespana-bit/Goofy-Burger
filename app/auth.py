"""Autenticación opcional por HTTP Basic.

Pensada para cuando expongas Vigía fuera de casa: se activa con
``general.auth_enabled`` en la configuración.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
from typing import Optional

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from .config import config

security = HTTPBasic(auto_error=False)


def hash_password(password: str, salt: Optional[str] = None) -> str:
    salt = salt or secrets.token_hex(8)
    digest = hashlib.pbkdf2_hex(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), 60000
    )
    return f"pbkdf2_sha256${salt}${digest}"


def verify_password(password: str, stored: str) -> bool:
    if not stored:
        return False
    try:
        algo, salt, digest = stored.split("$", 2)
    except ValueError:
        return stored == password  # compatibilidad con texto plano
    if algo != "pbkdf2_sha256":
        return False
    computed = hashlib.pbkdf2_hex(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), 60000
    )
    return secrets.compare_digest(computed, digest)


def auth_required() -> bool:
    return bool(config.data.get("general", {}).get("auth_enabled"))


def _authorized(request: Request) -> bool:
    if not auth_required():
        return True
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("basic "):
        return False
    try:
        decoded = base64.b64decode(header.split(" ", 1)[1]).decode("utf-8")
        username, _, password = decoded.partition(":")
    except Exception:
        return False
    general = config.data.get("general", {})
    if not secrets.compare_digest(username, general.get("username", "admin")):
        return False
    return verify_password(password, general.get("password_hash", ""))


async def require_auth(
    request: Request, credentials: Optional[HTTPBasicCredentials] = Depends(security)
) -> bool:
    if not auth_required():
        return True
    if _authorized(request):
        return True
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="No autenticado",
        headers={"WWW-Authenticate": 'Basic realm="Vigia"'},
    )
