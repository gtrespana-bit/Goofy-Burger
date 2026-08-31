"""Información del sistema, autodescubrimiento y mantenimiento."""

from __future__ import annotations

import platform
import sys
import time
from typing import List, Optional

import cv2
from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel

from ..config import config
from ..services import discovery, onvif_client
from ..services.capture import list_usb_devices
from ..services.manager import manager
from ..services.recorder import ffmpeg_path
from ..services.retention import storage_stats
from .. import events_store

router = APIRouter(prefix="/system", tags=["system"])

START_TIME = time.time()
VERSION = "0.1.0"


def _ultralytics_available() -> bool:
    try:
        import ultralytics  # noqa: F401

        return True
    except Exception:
        return False


@router.get("/info")
def info():
    exe = ffmpeg_path()
    return {
        "version": VERSION,
        "python": sys.version.split()[0],
        "platform": f"{platform.system()} {platform.release()}",
        "hostname": platform.node(),
        "uptime_seconds": int(time.time() - START_TIME),
        "ffmpeg": exe or None,
        "opencv": cv2.__version__,
        "onvif_available": onvif_client.ONVIF_AVAILABLE,
        "onvif_hint": onvif_client.ONVIF_IMPORT_ERROR,
        "ai_available": _ultralytics_available(),
        "auth_enabled": bool(config.data.get("general", {}).get("auth_enabled")),
        "away": bool(config.data.get("general", {}).get("away")),
        "storage": storage_stats(),
        "cameras": len(config.cameras()),
        "events_unacknowledged": events_store.count_unacknowledged(),
        "local_ip": discovery.local_ip(),
    }


class DiscoverRequest(BaseModel):
    mode: str = "onvif"          # onvif | scan | rtsp
    target: str = ""             # ip, host o CIDR
    username: str = ""
    password: str = ""
    ports: Optional[List[int]] = None
    paths: Optional[List[str]] = None
    timeout: float = 4.0


@router.post("/discover")
def discover(req: DiscoverRequest):
    """Busca cámaras en la red local."""
    try:
        if req.mode == "onvif":
            devices = discovery.discover_onvif(timeout=req.timeout)
            if req.username:
                from concurrent.futures import ThreadPoolExecutor

                def enrich(dev):
                    try:
                        urls = discovery.probe_rtsp(
                            dev["ip"], req.username, req.password, workers=12, timeout=2.0
                        )
                        dev["rtsp_candidates"] = urls[:8]
                    except Exception:
                        dev["rtsp_candidates"] = []
                    return dev

                with ThreadPoolExecutor(max_workers=4) as pool:
                    devices = list(pool.map(enrich, devices))
            return {"mode": "onvif", "devices": devices}

        if req.mode == "scan":
            hosts = discovery.scan_network(req.target or None, req.ports)
            return {"mode": "scan", "devices": hosts, "subnet": req.target or discovery.local_subnets()}

        if req.mode == "rtsp":
            if not req.target:
                raise HTTPException(400, "Indica la IP de la cámara en 'target'")
            urls = discovery.probe_rtsp(
                req.target, req.username, req.password,
                ports=req.ports, paths=req.paths, timeout=max(1.5, req.timeout / 2),
            )
            return {"mode": "rtsp", "target": req.target, "urls": urls}

        raise HTTPException(400, f"Modo desconocido: {req.mode}")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"{type(exc).__name__}: {exc}")


@router.post("/diagnose")
def diagnose(req: DiscoverRequest):
    """Diagnóstico de una IP concreta (pensado para cámaras iCSee/XMEye).

    Comprueba puertos, sondea todas las variantes RTSP (incluida la de
    'admin' sin contraseña) y, si el puerto ONVIF (8899) está abierto,
    enumera los perfiles de vídeo (cada lente de una multi-lente = un perfil
    con su propia URL RTSP) para poder añadirlas todas de golpe.
    """
    if not req.target:
        raise HTTPException(400, "Indica la IP de la cámara en 'target'")
    try:
        report = discovery.diagnose_camera(
            req.target, req.username, req.password,
            timeout=max(0.8, req.timeout / 3),
            rtsp_timeout=max(1.2, req.timeout / 3),
        )
        # Si ONVIF está abierto, enumera perfiles (multi-lente) con su stream.
        # No limitamos a 8899: probamos 80/8080/8000/8899 automáticamente.
        if onvif_client.ONVIF_AVAILABLE and (
            any(p["open"] for p in report.get("ports", [])
                if p["port"] in (80, 8080, 8000, 8899))
        ):
            onvif_info = _probe_onvif_profiles(
                req.target, req.username, req.password
            )
            if onvif_info:
                report["onvif_profiles"] = onvif_info
                report["channels"] = _annotate_channels_onvif(
                    report.get("channels", {}), onvif_info
                )
            else:
                report["hints"].append(
                    "Hay un puerto ONVIF abierto pero no se pudieron leer "
                    "perfiles con esas credenciales. Prueba con 'admin' y la "
                    "contraseña de admin de la cámara (no la de la app)."
                )
        return report
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"{type(exc).__name__}: {exc}")


def _probe_onvif_profiles(host: str, username: str, password: str) -> dict:
    """Enumera perfiles ONVIF probando varios puertos y credenciales.

    Las cámaras iCSee/XMEye suelen poner ONVIF en 8899, pero otras en 80,
    8080 o 8000. Devuelve el puerto que funcione y un perfil por lente.
    """
    import logging

    log = logging.getLogger("vigia")
    ports = [8899, 80, 8080, 8000]
    candidates = [(username or "", password or "")]
    if (username or "").lower() != "admin":
        candidates += [("admin", password or ""), ("admin", "")]
    if not candidates[0][0]:
        candidates = [("admin", ""), ("admin", password or "")]

    for port in ports:
        for u, pw in candidates:
            try:
                device = onvif_client.OnvifDevice(host, port, u, pw)
                device.connect()
                profiles = device.profiles_with_streams()
                has_ptz = device.has_ptz() or any(p.get("has_ptz") for p in profiles)
                if profiles:
                    return {
                        "port": port,
                        "username": u,
                        "password": bool(pw),
                        "profiles": profiles,
                        "has_ptz": has_ptz,
                    }
                if has_ptz:
                    # El dispositivo habla ONVIF/PTZ aunque no liste perfiles.
                    return {
                        "port": port,
                        "username": u,
                        "password": bool(pw),
                        "profiles": [],
                        "has_ptz": True,
                    }
            except Exception as exc:
                log.debug("ONVIF %s:%s con %s: %s", host, port, u or "(vacío)", exc)
    return {}


def _annotate_channels_onvif(channels: dict, onvif_info: dict) -> dict:
    """Cruza los canales RTSP detectados con los perfiles ONVIF.

    Añade a cada canal el token del perfil que le corresponde (y el perfil PTZ
    si la cámara tiene una lente giratoria). Así el asistente puede crear las
    cámaras correctas y poner PTZ sólo donde corresponde.
    """
    import re as _re

    channels = dict(channels or {})
    groups = list(channels.get("groups") or [])
    profiles = list(onvif_info.get("profiles") or [])

    def _profile_channel(profile: dict) -> str:
        u = profile.get("rtsp") or ""
        m = _re.search(r"(?:^|[?&_/])channel=(\d+)", u, _re.I)
        return m.group(1) if m else ""

    for g in groups:
        ch = str(g.get("channel", ""))
        matched = None
        for profile in profiles:
            if _profile_channel(profile) == ch:
                matched = profile
                break
        if matched is None and len(profiles) == len([x for x in groups if not x.get("mosaic")]):
            # Orden estable: los perfiles de estas cámaras suelen ir en orden
            # de lente. Usamos la posición del canal dentro de los no-mosaico.
            idx = [x for x in groups if not x.get("mosaic")].index(g)
            if 0 <= idx < len(profiles):
                matched = profiles[idx]
        if matched is not None:
            g["profile_token"] = matched.get("token", "")
            g["has_ptz"] = bool(matched.get("has_ptz"))
            if not g.get("main") and matched.get("rtsp"):
                g["main"] = matched["rtsp"]
        elif onvif_info.get("has_ptz"):
            g["has_ptz"] = True

    # La lente giratoria normalmente es la primera con has_ptz; la dejamos
    # indicada en el grupo para que la UI la marque.
    ptz_profile = None
    for profile in profiles:
        if profile.get("has_ptz"):
            ptz_profile = profile
            break
    if ptz_profile is None and profiles:
        ptz_profile = profiles[0]

    channels["groups"] = groups
    channels["onvif_port"] = onvif_info.get("port")
    channels["username"] = onvif_info.get("username", "")
    channels["password_present"] = bool(onvif_info.get("password"))
    channels["ptz_profile_token"] = ptz_profile.get("token", "") if ptz_profile else ""
    channels["has_ptz"] = bool(onvif_info.get("has_ptz") or ptz_profile)
    return channels


@router.get("/usb")
def usb_devices():
    return {"devices": list_usb_devices()}


@router.post("/away")
def set_away(value: bool = Body(True, embed=True)):
    """Modo 'fuera de casa': habilita las alertas marcadas como only_when_away."""
    config.update_section("general", {"away": bool(value)})
    return {"away": bool(value)}


@router.get("/health")
def health():
    statuses = {}
    for cam in config.cameras():
        statuses[cam["id"]] = {
            "name": cam.get("name"),
            "enabled": cam.get("enabled", True),
            **manager.status(cam["id"]),
        }
    return {
        "ok": True,
        "uptime": int(time.time() - START_TIME),
        "cameras": statuses,
    }
