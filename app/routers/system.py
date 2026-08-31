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
