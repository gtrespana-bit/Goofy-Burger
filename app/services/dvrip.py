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

import json
import logging
import socket
import struct
import time
from typing import Any, Dict, List, Optional

log = logging.getLogger("vigia.dvrip")

DVRIP_PORT = 34567

# Tipos de mensaje DVRIP que la librería `dvrip` NO expone (los mandamos crudos):
DVRIP_KEEPALIVE = 1006       # {"Name":"KeepAlive","SessionID":"0x..."}
DVRIP_PTZ_CTRL = 1400        # OPPTZControl (mover/zoom de la lente giratoria)
DVRIP_MEDIA_VIDEO = 1412     # paquetes de vídeo del canal monitorizado
DVRIP_LOGOUT = 1002          # {"Name":"","SessionID":"0x..."} (mismo que ClientLogout)

# Firmas de trama dentro del payload de un paquete 1412 (protocolo Sofia/XM):
# cada frame viene precedido de "00 00 01" + un byte de tipo. El resto de los
# paquetes son "continuación" de un frame y llevan NAL en bruto.
MEDIA_SIG = b"\x00\x00\x01"
MEDIA_IFRAME = 0xFC          # cabecera de 16 bytes + NAL
MEDIA_PFRAME = 0xFD          # cabecera de 8 bytes + NAL
MEDIA_PLUSENC = 0xF9         # como I-Frame (H.264+/H.265+)
MEDIA_AUDIO = 0xFA           # descartar (audio G.711)

try:
    from dvrip import DVRIP_PORT as _LIB_PORT  # type: ignore
    from dvrip.io import DVRIPClient, DVRIPConnection  # type: ignore
    from dvrip.monitor import Stream  # type: ignore

    DVRIP_AVAILABLE = True
    DVRIP_ERROR = ""
except Exception as exc:  # pragma: no cover - entorno
    DVRIPClient = None  # type: ignore
    DVRIPConnection = None  # type: ignore
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


def _monitor_start(client, data_sock, channel: int, stream: str) -> None:
    """Arranca el monitor (claim + request) como ``DVRIPClient.monitor``, pero
    sin envolver el socket de datos en un ``DVRIPReader``: el llamador lee los
    paquetes de vídeo directamente con ``read_media_packet``.

    La razón es que ``DVRIPReader``/``streamfilter`` terminan el flujo cuando
    llega un paquete con el flag ``end`` (fin de trama), que en vídeo en vivo
    se pone en cada frame, no al final del stream. Aquí evitamos ese bug.
    """
    from dvrip.errors import DVRIPRequestError  # type: ignore
    from dvrip.monitor import (DoMonitor, Monitor, MonitorAction,  # type: ignore
                               MonitorClaim, MonitorParams)

    monitor = Monitor(
        action=MonitorAction.START,
        params=MonitorParams(
            channel=int(channel),
            stream=Stream.HD if stream != "sub" else Stream.SD,
        ),
    )
    claim = MonitorClaim(session=client.session, monitor=monitor)
    request = DoMonitor(session=client.session, monitor=monitor)
    data = DVRIPConnection(data_sock, client.session)
    data.send(data.number, claim)
    client.request(request)
    reply = data.recv(claim.replies(data.number))
    DVRIPRequestError.signal(claim, reply)


def stream_channel(host: str, username: str, password: str, channel: int,
                   port: int = DVRIP_PORT, stream: str = "main",
                   timeout: float = 4.0) -> tuple:
    """Abre un flujo de vídeo por canal.

    Devuelve ``(client, data_sock, control_sock)`` con el monitor ya arrancado;
    el socket de datos queda listo para leer paquetes con ``read_media_packet``.
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
        # El socket de datos lleva vídeo en continuo; un timeout generoso sirve
        # para detectar un flujo muerto sin falsos reconexiones.
        data_sock.settimeout(max(10.0, timeout))
        _monitor_start(client, data_sock, int(channel), stream)
        return client, data_sock, control_sock
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


def _recv_exact(sock, n: int) -> bytes:
    """Lee exactamente ``n`` bytes del socket. Lanza EOFError/TimeoutError."""
    buf = bytearray()
    while len(buf) < n:
        try:
            chunk = sock.recv(n - len(buf))
        except socket.timeout:
            raise TimeoutError("timeout leyendo el socket de datos DVRIP")
        if not chunk:
            raise EOFError("socket de datos DVRIP cerrado")
        buf.extend(chunk)
    return bytes(buf)


def read_media_packet(sock) -> tuple:
    """Lee el siguiente paquete DVRIP del socket de datos.

    Devuelve ``(type_id, payload)``. Lanza ``EOFError`` si el dispositivo
    cierra el socket y ``TimeoutError`` si se agota el timeout sin datos.
    """
    header = _recv_exact(sock, 20)
    if header[0] != 0xFF:
        raise ValueError(f"cabecera DVRIP inválida (0x{header[0]:02X})")
    typ = struct.unpack("<H", header[14:16])[0]
    length = struct.unpack("<I", header[16:20])[0]
    if length > 8 * 1024 * 1024:
        raise ValueError(f"paquete DVRIP demasiado grande ({length} bytes)")
    payload = _recv_exact(sock, length) if length else b""
    return typ, payload


def strip_media_header(payload: bytes) -> Optional[bytes]:
    """Devuelve los NAL de un payload 1412 sin la cabecera de trama.

    Formato Sofia/XM (confirmado con node_dvripclient):

    - ``00 00 01 FC`` (I-Frame) y ``00 00 01 F9`` (PlusEnc): cabecera 16 bytes.
    - ``00 00 01 FD`` (P-Frame): cabecera 8 bytes.
    - ``00 00 01 FA`` (Audio): se descarta (devuelve ``None``).
    - Sin prefijo ``00 00 01``: paquete de continuación, NAL en bruto.

    Estas cabeceras, si se pasan a ffmpeg, corrompen el flujo y el directo se
    queda en el primer fotograma (vídeo estático).
    """
    if payload[:3] != MEDIA_SIG:
        return payload  # continuación de trama
    kind = payload[3]
    if kind == MEDIA_AUDIO:
        return None
    if kind in (MEDIA_IFRAME, MEDIA_PLUSENC):
        return payload[16:] if len(payload) > 16 else b""
    if kind == MEDIA_PFRAME:
        return payload[8:] if len(payload) > 8 else b""
    # Prefijo 00 00 01 con tipo desconocido: probablemente un paquete de
    # continuación que casualmente empieza por 00 00 01; lo pasamos tal cual.
    return payload


def _session_id_hex(client) -> str:
    session = getattr(client, "session", None)
    sid = int(getattr(session, "id", 0) or 0)
    return "0x%08X" % sid


def send_control(client, control_sock, type_id: int, payload: Dict[str, Any]) -> bool:
    """Envía un mensaje de control DVRIP crudo por el socket de control.

    La librería `dvrip` no expone KeepAlive ni PTZ, así que empaquetamos el
    mensaje igual que ``ControlMessage.topackets`` (versión 1, JSON ascii) y lo
    escribimos en el mismo fichero que usa el cliente. No espera respuesta.
    """
    if client is None:
        return False
    try:
        from dvrip.packet import Packet
    except Exception:  # pragma: no cover
        return False
    if getattr(client, "session", None) is None:
        return False
    try:
        body = json.dumps(payload, separators=(",", ":")).encode("ascii")
        # Número de secuencia creciente, continuando el contador que ya usó la
        # librería durante el handshake (login/systeminfo/monitor). El cliente
        # usa __slots__, así que reutilizamos `number` en lugar de añadir campos.
        num = int(getattr(client, "number", 0) or 0) + 2
        try:
            client.number = num
        except Exception:  # pragma: no cover
            pass
        pkt = Packet(
            session=int(getattr(client.session, "id", 0) or 0),
            number=num, type=int(type_id), payload=body,
            fragments=0, fragment=0,
        )
        file = getattr(client, "file", None)
        if file is None:
            file = control_sock.makefile("wb", buffering=0)
        pkt.dump(file)
        return True
    except Exception:
        return False


def keepalive(client, control_sock) -> bool:
    """Envía un KeepAlive (evita que la cámara corte la sesión/el vídeo)."""
    return send_control(client, control_sock, DVRIP_KEEPALIVE, {
        "Name": "KeepAlive",
        "SessionID": _session_id_hex(client),
    })


def logout(client, control_sock) -> bool:
    """Envía el logout sin esperar respuesta.

    ``client.logout()`` (de la librería) se bloquea esperando la respuesta y
    muchas cámaras no la envían; además, si hay replies de keep-alive/PTZ sin
    leer, ``recv`` falla con "stray packet". El logout fire-and-forget cierra
    la sesión igual (la cámara libera el canal al cerrarse el socket) y no
    ralentiza el cleanup/reconexión.
    """
    return send_control(client, control_sock, DVRIP_LOGOUT, {
        "Name": "",
        "SessionID": _session_id_hex(client),
    })


_PTZ_COMMANDS = {
    "up": "DirectionUp",
    "down": "DirectionDown",
    "left": "DirectionLeft",
    "right": "DirectionRight",
    "zoom_in": "ZoomTile",
    "zoom_out": "ZoomWide",
    "goto_preset": "GotoPreset",
}


def ptz_control(client, control_sock, command: str, channel: int = 0,
                step: int = 5, preset: int = -1) -> bool:
    """Mueve/hace zoom en la lente giratoria vía DVRIP (OPPTZControl)."""
    if command not in _PTZ_COMMANDS:
        return False
    parameter = {
        "AUX": {"Number": 0, "Status": "On"},
        "Channel": int(channel or 0),
        "MenuOpts": "Enter",
        "Pattern": "Start",
        "Preset": int(preset),
        "Step": int(step),
        "Tour": 0,
    }
    return send_control(client, control_sock, DVRIP_PTZ_CTRL, {
        "Name": "OPPTZControl",
        "SessionID": _session_id_hex(client),
        "OPPTZControl": {"Command": _PTZ_COMMANDS[command], "Parameter": parameter},
    })
