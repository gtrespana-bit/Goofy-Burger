"""Autenticación opcional: usuarios con roles, 2FA TOTP y tokens de API.

Pensada para cuando expongas Vigía fuera de casa. Se activa con
``general.auth_enabled`` en la configuración.

Modos admitidos:
- HTTP Basic con usuario/contraseña.
- ``Authorization: Bearer <token>`` o ``X-API-Key: <token>`` para scripts.
- 2FA opcional por usuario (código TOTP en cabecera ``X-2FA-Code``).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from .config import config

security = HTTPBasic(auto_error=False)

ROLES = ("admin", "viewer")
WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
SESSION_COOKIE = "vigia_session"
SESSION_MAX_AGE = 60 * 60 * 24 * 30
_lockout = {"attempts": 0, "until": 0.0}


def hash_password(password: str, salt: Optional[str] = None) -> str:
    salt = salt or secrets.token_hex(8)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), 60000
    )
    return f"pbkdf2_sha256${salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    if not stored:
        return False
    try:
        algo, salt, digest = stored.split("$", 2)
    except ValueError:
        return stored == password  # compatibilidad con texto plano
    if algo != "pbkdf2_sha256":
        return False
    computed = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), 60000
    ).hex()
    return secrets.compare_digest(computed, digest)


def hash_token(token: str) -> str:
    return "sha256:" + hashlib.sha256(token.encode("utf-8")).hexdigest()


def verify_token(token: str, stored: str) -> bool:
    if not stored:
        return False
    if stored.startswith("sha256:"):
        return secrets.compare_digest(hash_token(token), stored)
    return secrets.compare_digest(token, stored)


# --------------------------------------------------------------------------
# TOTP (2FA) implementado en stdlib (no requiere pyotp)
# --------------------------------------------------------------------------
def _base32_decode(value: str) -> bytes:
    value = value.strip().replace(" ", "").upper().replace("=", "")
    if not value:
        return b""
    # El RFC exige padding; nuestras claves se guardan sin él.
    value += "=" * ((8 - len(value) % 8) % 8)
    return base64.b32decode(value)


def generate_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(16)).decode("ascii").rstrip("=")


def totp_code(secret: str, interval: int = 30, offset: int = 0) -> str:
    key = _base32_decode(secret)
    if not key:
        return ""
    counter = int(time.time() // interval) + offset
    msg = counter.to_bytes(8, "big")
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    offset_byte = digest[-1] & 0x0F
    code_int = (
        (digest[offset_byte] & 0x7F) << 24
        | (digest[offset_byte + 1] & 0xFF) << 16
        | (digest[offset_byte + 2] & 0xFF) << 8
        | (digest[offset_byte + 3] & 0xFF)
    )
    return str(code_int % 1000000).zfill(6)


def verify_totp(secret: str, code: str) -> bool:
    if not secret or not code:
        return False
    code = str(code).strip().replace(" ", "")
    for offset in (0, -1, 1):
        if secrets.compare_digest(totp_code(secret, offset=offset), code):
            return True
    return False


def login_user(username: str, password: str, code: str = "") -> Optional[Dict[str, Any]]:
    """Valida credenciales con bloqueo temporal de fuerza bruta."""
    now = time.time()
    if now < _lockout["until"]:
        return None
    user = _find_user(username or "")
    ok = bool(user and verify_password(password or "", user.get("password_hash", "")))
    if ok and user.get("totp_enabled"):
        ok = verify_totp(user.get("totp_secret", ""), code)
    if not ok:
        _lockout["attempts"] += 1
        if _lockout["attempts"] >= 10:
            _lockout["attempts"] = 0
            _lockout["until"] = now + 300
        return None
    _lockout["attempts"] = 0
    _lockout["until"] = 0.0
    return user


# --------------------------------------------------------------------------
# Usuarios y tokens
# --------------------------------------------------------------------------
def users() -> list:
    general = config.data.get("general", {})
    items = list(general.get("users") or [])
    # Compatibilidad: la cuenta única de configuraciones antiguas se sigue
    # aceptando aunque ya existan usuarios multi-cuenta.
    username = general.get("username", "admin")
    if username or general.get("password_hash"):
        if not any(u.get("username") == username for u in items):
            items.append({
                "username": username or "admin",
                "name": "Administrador",
                "role": "admin",
                "password_hash": general.get("password_hash", ""),
                "totp_secret": "",
                "totp_enabled": False,
            })
    return items


def api_tokens() -> list:
    return list(config.data.get("general", {}).get("api_tokens") or [])


def create_session(username: str, role: str, name: str = "") -> str:
    """Crea un token de sesión web y lo guarda como ``api_token`` temporal."""
    token = secrets.token_urlsafe(32)
    general = config.section("general")
    tokens: List[Dict[str, Any]] = list(general.get("api_tokens") or [])
    # Limpia sesiones antiguas para no llenar el fichero.
    now = time.time()
    kept = []
    for item in tokens:
        if item.get("session"):
            created = item.get("created_at", "")
            try:
                age = now - datetime.fromisoformat(str(created)).timestamp()
                if age < 31 * 24 * 3600 and item.get("username") != username:
                    kept.append(item)
            except Exception:
                pass
        else:
            kept.append(item)
    kept.append({
        "name": f"session:{username}:{secrets.token_hex(4)}",
        "role": role,
        "token_hash": hash_token(token),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "session": True,
        "username": username,
        "user_name": name or username,
    })
    config.update_section("general", {"api_tokens": kept})
    return token


def delete_session(token: str) -> None:
    general = config.section("general")
    tokens: List[Dict[str, Any]] = list(general.get("api_tokens") or [])
    removed = False
    for item in tokens:
        if item.get("session") and verify_token(token, item.get("token_hash", "")):
            tokens.remove(item)
            removed = True
            break
    if removed:
        config.update_section("general", {"api_tokens": tokens})


def auth_required() -> bool:
    return bool(config.data.get("general", {}).get("auth_enabled"))


def _find_user(username: str) -> Optional[Dict[str, Any]]:
    for user in users():
        if secrets.compare_digest(username, user.get("username", "")):
            return user
    return None


def _user_from_basic(request: Request) -> Optional[Dict[str, Any]]:
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("basic "):
        return None
    try:
        decoded = base64.b64decode(header.split(" ", 1)[1]).decode("utf-8")
        username, _, password = decoded.partition(":")
    except Exception:
        return None
    user = _find_user(username)
    if not user:
        return None
    if not verify_password(password, user.get("password_hash", "")):
        return None
    return user


def _user_from_token(request: Request) -> Optional[Dict[str, Any]]:
    raw = request.headers.get("authorization", "")
    key = request.headers.get("x-api-key", "")
    token = ""
    if raw.lower().startswith("bearer "):
        token = raw.split(" ", 1)[1].strip()
    elif key:
        token = key.strip()
    if not token:
        return None
    for item in api_tokens():
        stored = item.get("token_hash", "")
        role = item.get("role", "admin")
        name = item.get("name", "API")
        if stored and verify_token(token, stored):
            return {"username": f"token:{name}", "role": role, "via": "token"}
    return None


def _user_from_cookie(request: Request) -> Optional[Dict[str, Any]]:
    token = request.cookies.get(SESSION_COOKIE, "")
    if not token:
        return None
    for item in api_tokens():
        if not item.get("session"):
            continue
        stored = item.get("token_hash", "")
        if stored and verify_token(token, stored):
            return {
                "username": item.get("username", "sesión"),
                "name": item.get("user_name", item.get("username", "sesión")),
                "role": item.get("role", "admin"),
                "via": "session",
                "session_token": token,
            }
    return None


def _authenticated(request: Request) -> Optional[Dict[str, Any]]:
    if not auth_required():
        # Sin autenticación todo es admin local.
        return {"username": "local", "role": "admin", "via": "local"}
    user = _user_from_token(request) or _user_from_cookie(request) or _user_from_basic(request)
    if not user:
        return None
    if user.get("via") in ("token", "session"):
        return user
    if user.get("totp_enabled"):
        code = request.headers.get("x-2fa-code", "")
        if not verify_totp(user.get("totp_secret", ""), code):
            return None
    return user


def _authorized(request: Request) -> bool:
    return _authenticated(request) is not None


def _denied() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="No autenticado",
        headers={"WWW-Authenticate": 'Basic realm="Vigia"'},
    )


async def require_auth(
    request: Request,
    credentials: Optional[HTTPBasicCredentials] = Depends(security),
) -> Dict[str, Any]:
    user = _authenticated(request)
    if user is None:
        raise _denied()
    return user


async def require_write(request: Request) -> Dict[str, Any]:
    """Permite lecturas a todos; escrituras (POST/PUT/PATCH/DELETE) sólo a admin."""
    if request.method not in WRITE_METHODS:
        return {"role": "ok"}
    user = _authenticated(request)
    if user is None:
        raise _denied()
    if user.get("role", "admin") != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Este rol de usuario no puede modificar la configuración.",
        )
    return user
