"""Soporte nativo DVRIP / NetIP (puerto 34567) para cámaras XiongMai/iCSee.

Muchas iCSee de varios lentes NO exponen todas las lentes por RTSP con
``channel=1/2/3``. El protocolo propietario (NetIP/DVRIP) que usa la app sí
las conoce: con él podemos:

- autenticarnos con la cuenta real (la del usuario o ``admin``),
- leer cuántas lentes (canales) tiene el dispositivo,
- saber su estado/bitrate,
- abrir un flujo de vídeo por canal y pasárselo a ffmpeg para decodificarlo.

Este módulo es un wrapper fino sobre la librería `dvrip` (OpenIPC/python-dvr).
Si no está instalada, Vigía sigue funcionando con RTSP/ONVIF, pero el
asistente te avisará de que el soporte nativo iCSee no está disponible.
"""

from __future__ import annotations

import logging
import socket
import time
from typing import Any, Dict, List, Optional

log = logging.getLogger("vigia.dvrip")

DVRIP_PORT = 34567

try:
    from dvrip import DVRIP_PORT as _LIB_PORT  # type: ignore
    from dvrip.io import DVRIPClient  # type: ignore
    from dvrip.monitor import Stream  # type: ignore

    DVRIP_AVAILABLE = True
    DVRIP_ERROR = ""
except Exception as exc:  # pragma: no cover - entorno
    DVRIPClient = None  # type: ignore
    Stream = None  # type: ignore
    DVRIP_AVAILABLE = False
    DVRIP_ERROR = str(exc)


def _patch_dvrip_tolerant_decode() -> None:
    """Hace tolerante el decodificador de la librería `dvrip`.

    La librería `dvrip` declara un esquema **estricto** para los mensajes y
    falla con ``DVRIPDecodeError: no member 'X'`` si el dispositivo omite
    cualquier campo obligatorio. Las cámaras iCSee/XMEye responden al login
    con un subconjunto (muchas veces sólo ``Ret`` y ``SessionID``), así que el
    login nunca completa, la cámara no abre y el worker entra en un bucle de
    reconexión sin fin (spam de errores + carga continua). Lo mismo ocurre con
    ``SystemInfo``/``ActivityInfo`` (el `probe`) y con el claim de monitor.

    Sustituimos ``Object.json_to`` (que heredan **todos** los tipos de
    mensaje) por un decodificador tolerante que:

    - normaliza las claves (algunas cámaras mandan ``DeviceType`` y el esquema
      declara ``DeviceType `` con un espacio final),
    - rellena los miembros ausentes o inválidos con un valor por defecto seguro
      (``0`` / ``""`` / ``False`` / ``[]`` / ``Status.OK`` / ``Session(0)``),
    - decodifica de forma recursiva los objetos anidados (``SystemInfo``,
      ``ActivityInfo``…) usando el decodificador ya tolerante,
    - ignora los campos extra que envíe el dispositivo.

    El codificador (``for_json``) no se toca: las peticiones salientes siguen
    siendo exactamente las que espera la cámara.
    """
    try:
        from dvrip import typing as _t
        from dvrip.message import Session, Status
        from typing import (
            Union,
            get_args as _get_args,
            get_origin as _get_origin,
            get_type_hints,
        )
    except Exception:  # pragma: no cover - librería con otra forma interna
        return

    try:
        _orig_json_to = _t.Object.json_to.__func__
    except Exception:  # pragma: no cover
        return

    _hints_cache: Dict[type, Dict[str, Any]] = {}

    def _hints(cls: type) -> Dict[str, Any]:
        try:
            return _hints_cache.setdefault(cls, get_type_hints(cls))
        except Exception:  # pragma: no cover
            return {}

    def _object_type(ann: Any) -> Any:
        """Tipo `Object` al que apunta una anotación (o None si es escalar)."""
        if ann is None:
            return None
        origin = _get_origin(ann)
        if origin in (_t.member, _t.optionalmember, _t.absentmember):
            return _object_type(_get_args(ann)[0])
        if origin is list:
            return _object_type(_get_args(ann)[0])
        if origin is Union:
            args = [a for a in _get_args(ann) if a is not type(None)]
            return _object_type(args[0]) if args else None
        if isinstance(ann, type) and issubclass(ann, _t.Object):
            return ann
        return None

    def _member_default(mname: str, m) -> Any:
        """Valor seguro para un miembro ausente o inválido."""
        if isinstance(m, (_t.absentmember, _t.optionalmember)):
            return NotImplemented
        if isinstance(m, _t.fixedmember):
            return m.default
        if mname == "status":
            return Status.OK
        if mname == "session":
            return Session(0)
        for candidate in (0, "", False, []):
            try:
                return m.json_to(candidate)
            except Exception:
                continue
        return None

    def _decode_member(mname: str, m, raw: Any, hints: Dict[str, Any]) -> Any:
        """Decodifica un valor; para objetos anidados usa el decoder tolerante."""
        target = _object_type(hints.get(mname))
        if target is not None:
            if isinstance(raw, list):
                return [target.json_to(item) for item in raw]
            return target.json_to(raw)
        return m.json_to(raw)

    @classmethod
    def _tolerant_json_to(cls, datum: object):
        if not isinstance(datum, dict):
            return _orig_json_to(cls, datum)
        working: Dict[str, Any] = {str(k).strip(): v for k, v in datum.items()}
        hints = _hints(cls)
        values: Dict[str, Any] = {}
        for mname in cls._members_:
            m = getattr(cls, mname)
            key = str(getattr(m, "key", mname) or mname).strip()
            if isinstance(m, _t.fixedmember):
                working.pop(key, None)
                values[mname] = m.default
                continue
            if key not in working:
                values[mname] = _member_default(mname, m)
                continue
            raw = working.pop(key)
            try:
                values[mname] = _decode_member(mname, m, raw, hints)
            except Exception:
                values[mname] = _member_default(mname, m)
        # Los campos que sobren (extra members) se ignoran: no llamamos a _end_.
        obj = object.__new__(cls)
        container = object.__new__(cls._container_)
        for mname, val in values.items():
            try:
                setattr(container, mname, val)
            except Exception:  # pragma: no cover
                pass
        obj._values_ = container
        return obj

    _t.Object.json_to = _tolerant_json_to


if DVRIP_AVAILABLE:
    _patch_dvrip_tolerant_decode()


# `import dvrip` se ejecutaba en CADA petición de /system/info y /diagnostics.
# La disponibilidad de la librería no cambia mientras el servidor corre, así
# que se comprueba una vez y se cachea.
_avail_cache = {"ts": 0.0, "val": None}
AVAIL_TTL = 120.0


def available() -> bool:
    global DVRIP_AVAILABLE, DVRIP_ERROR
    now = time.time()
    cached = _avail_cache.get("val")
    if cached is not None and (now - _avail_cache["ts"]) < AVAIL_TTL:
        return bool(cached)
    try:
        import dvrip  # noqa: F401
        import dvrip.io  # noqa: F401

        DVRIP_AVAILABLE = True
        DVRIP_ERROR = ""
    except Exception as exc:
        DVRIP_AVAILABLE = False
        DVRIP_ERROR = str(exc)
    _avail_cache["ts"] = now
    _avail_cache["val"] = DVRIP_AVAILABLE
    return DVRIP_AVAILABLE


def _open_client(host: str, port: int = DVRIP_PORT, timeout: float = 4.0) -> Optional[DVRIPClient]:
    """Abre el socket de control y devuelve un cliente sin autenticar."""
    if not DVRIP_AVAILABLE:
        return None
    sock = socket.create_connection((host, port), timeout=timeout)
    return DVRIPClient(sock)


def friendly_login_error(exc: Exception) -> Optional[str]:
    """Traduce un error de login DVRIP a un mensaje accionable (o ``None``).

    ``DVRIPRequestError`` lleva el código de estado que devuelve la cámara;
    con él distinguimos "bloqueado por exceso de intentos" (muy habitual tras
    reintentar durante horas) de "credenciales incorrectas" o "sesión abierta".
    """
    try:
        from dvrip.errors import DVRIPRequestError
    except Exception:  # pragma: no cover
        return None
    if not isinstance(exc, DVRIPRequestError):
        return None
    code = getattr(exc, "code", None)
    if code in (205, 206):  # LOCKOUT / BANNED
        return (
            "la cámara ha bloqueado temporalmente el login por demasiados "
            "intentos. Espera 10-30 minutos o reinicia la cámara, y usa las "
            "credenciales correctas de la app iCSee."
        )
    if code in (106, 203, 204):  # CREDS / PASSWORD / USERNAME
        return (
            "credenciales incorrectas para DVRIP/NetIP. Usa la misma cuenta "
            "que en la app iCSee (o admin con su contraseña)."
        )
    if code == 207:  # CONFLICT: ya hay una sesión abierta
        return (
            "la cámara ya tiene una sesión DVRIP abierta (quizá la app iCSee). "
            "Ciérrala o espera unos minutos y reintenta."
        )
    return None


def _credential_candidates(username: str, password: str) -> List[tuple]:
    us = (username or "").strip()
    pw = password or ""
    out: List[tuple] = []
    if us:
        out.append((us, pw))
    if us.lower() != "admin":
        out.append(("admin", pw))
        out.append(("admin", ""))
    if not out:
        out = [("admin", ""), ("admin", pw)]
    return out


def probe(host: str, username: str = "", password: str = "", port: int = DVRIP_PORT,
          timeout: float = 4.0) -> Dict[str, Any]:
    """Conecta por DVRIP/NetIP y devuelve lentes, modelo y estado.

    Devuelve un dict apto para la API (nunca lanza si no hay librería).
    """
    host = (host or "").strip()
    result: Dict[str, Any] = {
        "available": available(),
        "error": "" if available() else DVRIP_ERROR,
        "host": host,
        "port": int(port or DVRIP_PORT),
        "login_ok": False,
        "username": "",
        "password_present": False,
        "channels": 0,
        "device": {},
        "lenses": [],
        "hints": [],
    }
    if not host or not available():
        if not available():
            result["hints"].append(
                "Librería DVRIP no instalada. Ejecuta: pip install dvrip"
            )
        return result

    connection_failures = 0
    for u, pw in _credential_candidates(username, password):
        client = None
        control_sock = None
        try:
            control_sock = socket.create_connection((host, int(port or DVRIP_PORT)), timeout=timeout)
            control_sock.settimeout(timeout)
            client = DVRIPClient(control_sock)
            client.login(u, pw)
            info = client.systeminfo()
            activity = client.activityinfo()
            login_info = getattr(client, "_logininfo", None)

            count = max(
                1,
                int(getattr(info, "videoin", 0) or 0),
                int(getattr(login_info, "channels", 0) or 0),
                int(getattr(login_info, "views", 0) or 0),
            )
            channels_state = list(getattr(activity, "channels", None) or [])
            lenses = []
            for i in range(count):
                state = channels_state[i] if i < len(channels_state) else None
                lenses.append({
                    "index": i,
                    "channel": i + 1,          # canal 1-based para RTSP/URL
                    "label": f"Lente {i + 1}",
                    "recording": bool(getattr(state, "recording", False)),
                    "bitrate_kbps": int(getattr(state, "bitrate", 0) or 0),
                })
            result.update({
                "login_ok": True,
                "username": u,
                "password_present": bool(pw),
                "channels": count,
                "device": {
                    "serial": str(getattr(info, "serial", "") or ""),
                    "hardware": str(getattr(info, "hardware", "") or ""),
                    "software": str(getattr(info, "software", "") or ""),
                    "build": str(getattr(info, "build", "") or ""),
                    "chassis": str(getattr(info, "chassis", "") or ""),
                    "videoin": int(getattr(info, "videoin", 0) or 0),
                    "views": int(getattr(info, "views", 0) or 0),
                    "uptime_minutes": int(getattr(info, "uptime", 0) or 0),
                },
                "lenses": lenses,
                "hints": [
                    f"Puerto {int(port or DVRIP_PORT)} abierto: DVRIP/NetIP (protocolo "
                    "propietario iCSee). Se pueden enumerar y abrir todas las lentes."
                ],
            })
            return result
        except Exception as exc:
            log.debug("DVRIP %s con %s: %s", host, u or "(vacío)", exc)
            friendly = friendly_login_error(exc)
            if friendly:
                # Si la cámara bloqueó el login o las credenciales son inválidas,
                # no tiene sentido seguir probando combinaciones: salimos ya con
                # el mensaje claro (y evitamos agravar el bloqueo).
                result["hints"].append(f"Login DVRIP con '{u}': {friendly}")
                break
            code = getattr(exc, "errno", None)
            if code in (111, 10061) or isinstance(exc, ConnectionRefusedError):
                connection_failures += 1
            else:
                result["hints"].append(f"Login DVRIP con '{u}' falló: {type(exc).__name__}: {exc}")
        finally:
            try:
                if client is not None:
                    try:
                        client.logout()
                    except Exception:
                        pass
                if control_sock is not None:
                    control_sock.close()
            except Exception:
                pass

    if not result["login_ok"]:
        if connection_failures:
            result["hints"].append(
                f"No se pudo conectar por DVRIP al puerto {int(port or DVRIP_PORT)} "
                "(conexión rechazada o sin respuesta). Revisa que la cámara tenga "
                "el puerto NetIP habilitado y que esté encendida."
            )
        else:
            result["hints"].append(
                "DVRIP responde pero no autentica con esas credenciales. Para iCSee "
                "prueba la cuenta que usas en la app o admin/la contraseña de admin "
                "(no la de la app)."
            )
    return result


def discover(timeout: float = 2.5, interface: Optional[str] = None) -> List[Dict[str, Any]]:
    """Descubre cámaras DVRIP por broadcast UDP (puerto 34569)."""
    if not available():
        return []
    from ..services.discovery import local_ip

    iface = interface or local_ip()
    out: List[Dict[str, Any]] = []
    try:
        for dev in DVRIPClient.discover(iface, timeout):
            out.append({
                "ip": str(getattr(dev, "host", "")),
                "serial": str(getattr(dev, "serial", "") or ""),
                "mac": str(getattr(dev, "mac", "") or ""),
                "name": str(getattr(dev, "name", "") or ""),
                "mask": str(getattr(dev, "mask", "") or ""),
                "router": str(getattr(dev, "router", "") or ""),
                "port": int(getattr(dev, "tcpport", 0) or DVRIP_PORT),
                "channels": int(getattr(dev, "channels", 0) or 0),
                "protocol": "dvrip",
            })
    except Exception as exc:
        log.debug("Descubrimiento DVRIP: %s", exc)
    return out


def stream_channel(host: str, username: str, password: str, channel: int,
                   port: int = DVRIP_PORT, stream: str = "main",
                   timeout: float = 4.0) -> tuple:
    """Abre un flujo de vídeo por canal.

    Devuelve ``(client, data_sock, control_sock, raw_stream)`` o lanza.
    El llamador debe cerrarlos todos.
    """
    if not DVRIP_AVAILABLE:
        raise RuntimeError(f"DVRIP no disponible: {DVRIP_ERROR}")
    control_sock = None
    client = None
    data_sock = None
    try:
        control_sock = socket.create_connection((host, int(port or DVRIP_PORT)), timeout=timeout)
        control_sock.settimeout(timeout)
        client = DVRIPClient(control_sock)
        client.login(username or "", password or "")
        data_sock = socket.create_connection((host, int(port or DVRIP_PORT)), timeout=timeout)
        data_sock.settimeout(timeout)
        raw = client.monitor(data_sock, int(channel), Stream.HD if stream != "sub" else Stream.SD)
        return client, data_sock, control_sock, raw
    except Exception:
        for obj in (data_sock, control_sock):
            if obj is not None:
                try:
                    obj.close()
                except Exception:
                    pass
        if client is not None:
            try:
                client.logout()
            except Exception:
                pass
        raise
