"""API de cámaras: alta, edición, pruebas, PTZ y sondeo ONVIF."""

from __future__ import annotations


from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict

import cv2
from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import BaseModel

from ..config import config
from ..models import build_camera, redact
from ..services import onvif_client
from ..services.capture import probe_snapshot, usb_device_names_windows, list_usb_devices
from ..services.manager import manager
from ..services.onvif_client import OnvifDevice, OnvifError

router = APIRouter(prefix="/cameras", tags=["cameras"])
_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="cameras")


def _defaults() -> Dict[str, Any]:
    data = config.snapshot()
    return {"detection": data.get("detection", {}), "recording": data.get("recording", {})}


@router.get("")
def list_cameras():
    return {"cameras": manager.cameras_with_status()}


@router.post("", status_code=201)
def create_camera(payload: Dict[str, Any] = Body(...)):
    cam = build_camera(payload, _defaults())
    if not cam["name"]:
        raise HTTPException(400, "Falta el nombre")
    config.add_camera(cam)
    if cam.get("enabled", True):
        manager.start(cam)
    return {"camera": cam}


@router.get("/{camera_id}")
def get_camera(camera_id: str):
    cam = config.get_camera(camera_id)
    if not cam:
        raise HTTPException(404, "Cámara no encontrada")
    cam["health"] = manager.status(camera_id)
    return {"camera": cam}


@router.patch("/{camera_id}")
def update_camera(camera_id: str, patch: Dict[str, Any] = Body(...)):
    if not config.get_camera(camera_id):
        raise HTTPException(404, "Cámara no encontrada")
    patch.pop("id", None)
    cam = config.update_camera(camera_id, patch)
    manager.sync(config.cameras())
    if cam:
        cam["health"] = manager.status(camera_id)
    return {"camera": cam}


@router.delete("/{camera_id}")
def delete_camera(camera_id: str, purge: bool = Query(False, description="Borra también grabaciones")):
    cam = config.get_camera(camera_id)
    if not cam:
        raise HTTPException(404, "Cámara no encontrada")
    manager.stop(camera_id)
    config.remove_camera(camera_id)
    if purge:
        from ..config import clips_dir, recordings_dir, snapshots_dir
        from ..models import slugify
        import shutil

        slug = slugify(camera_id)
        for base in (recordings_dir(), clips_dir(), snapshots_dir()):
            target = base / slug
            if target.exists():
                shutil.rmtree(target, ignore_errors=True)
    return {"ok": True}


@router.post("/{camera_id}/restart")
def restart_camera(camera_id: str):
    if not config.get_camera(camera_id):
        raise HTTPException(404, "Cámara no encontrada")
    manager.restart(camera_id)
    return {"ok": True}


@router.post("/{camera_id}/record")
def record_now(camera_id: str, seconds: int = Query(60, ge=5, le=3600)):
    if not config.get_camera(camera_id):
        raise HTTPException(404, "Cámara no encontrada")
    ok = manager.start_recording_now(camera_id, seconds)
    return {"ok": ok, "seconds": seconds}


@router.post("/test")
def test_source(payload: Dict[str, Any] = Body(...)):
    """Prueba una fuente sin guardarla: abre y lee un frame."""
    cam = build_camera(payload, _defaults())
    ok, frame, error = probe_snapshot(cam, timeout=float(payload.get("timeout", 8)))
    result: Dict[str, Any] = {"ok": ok, "error": error, "url": redact(cam.get("url", ""))}
    if ok and frame is not None:
        h, w = frame.shape[:2]
        result["resolution"] = f"{w}x{h}"
        ok_jpeg, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
        if ok_jpeg:
            import base64

            result["snapshot"] = "data:image/jpeg;base64," + base64.b64encode(
                buf.tobytes()
            ).decode()
    return result


# --------------------------------------------------------------------------
# ONVIF
# --------------------------------------------------------------------------
class OnvifProbeRequest(BaseModel):
    host: str
    port: int = 80
    username: str = ""
    password: str = ""


@router.post("/onvif/probe")
def onvif_probe(req: OnvifProbeRequest):
    """Conecta por ONVIF y devuelve perfiles + URL RTSP de cada uno."""
    if not onvif_client.ONVIF_AVAILABLE:
        raise HTTPException(
            400,
            "Dependencia ONVIF no instalada. Ejecuta: pip install onvif-zeep",
        )

    def work():
        device = OnvifDevice(req.host, req.port, req.username, req.password)
        device.connect()
        info = device.info()
        profiles = device.profiles()
        for profile in profiles:
            try:
                profile["rtsp"] = device.stream_uri(profile["token"])
            except Exception as exc:
                profile["rtsp"] = ""
                profile["error"] = str(exc)
            try:
                profile["snapshot"] = device.snapshot_uri(profile["token"])
            except Exception:
                profile["snapshot"] = ""
        return {"info": info, "profiles": profiles}

    try:
        return _executor.submit(work).result(timeout=40)
    except OnvifError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        raise HTTPException(500, f"{type(exc).__name__}: {exc}")


# --------------------------------------------------------------------------
# PTZ
# --------------------------------------------------------------------------
class PtzRequest(BaseModel):
    action: str = "move"          # move | stop | preset | home
    pan: float = 0.0              # -1..1
    tilt: float = 0.0             # -1..1
    zoom: float = 0.0             # -1..1
    duration: float = 0.4
    preset: str = ""


def _ptz_blocking(camera: Dict[str, Any], req: PtzRequest):
    onvif_cfg = camera.get("onvif") or {}
    host = onvif_cfg.get("host") or ""
    if not host:
        # deriva el host de la URL rtsp si no se indicó
        url = camera.get("url") or ""
        if "://" in url:
            host = url.split("://", 1)[1].split("@")[-1].split("/")[0].split(":")[0]
    if not host:
        raise HTTPException(400, "La cámara no tiene host ONVIF configurado")
    device = OnvifDevice(
        host,
        int(onvif_cfg.get("port") or 80),
        onvif_cfg.get("username") or camera.get("username") or "",
        onvif_cfg.get("password") or camera.get("password") or "",
    )
    device.connect()
    token = onvif_cfg.get("profile_token") or None
    if req.action == "move":
        device.ptz_move(req.pan, req.tilt, req.zoom, req.duration, token)
    elif req.action == "stop":
        device.ptz_stop(token)
    elif req.action == "preset":
        if not req.preset:
            raise HTTPException(400, "Falta el preset")
        device.ptz_goto_preset(req.preset, token)
    elif req.action == "home":
        device.ptz_home(token)
    else:
        raise HTTPException(400, f"Acción PTZ desconocida: {req.action}")
    return {"ok": True}


@router.post("/{camera_id}/ptz")
def ptz_control(camera_id: str, req: PtzRequest):
    camera = config.get_camera(camera_id)
    if not camera:
        raise HTTPException(404, "Cámara no encontrada")
    if not onvif_client.ONVIF_AVAILABLE:
        raise HTTPException(400, "Instala la dependencia ONVIF: pip install onvif-zeep")
    try:
        return _executor.submit(_ptz_blocking, camera, req).result(timeout=30)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"{type(exc).__name__}: {exc}")


@router.get("/{camera_id}/ptz/presets")
def ptz_presets(camera_id: str):
    camera = config.get_camera(camera_id)
    if not camera:
        raise HTTPException(404, "Cámara no encontrada")
    if not onvif_client.ONVIF_AVAILABLE:
        raise HTTPException(400, "Instala la dependencia ONVIF: pip install onvif-zeep")
    onvif_cfg = camera.get("onvif") or {}

    def work():
        device = OnvifDevice(
            onvif_cfg.get("host", ""),
            int(onvif_cfg.get("port") or 80),
            onvif_cfg.get("username") or camera.get("username") or "",
            onvif_cfg.get("password") or camera.get("password") or "",
        )
        device.connect()
        return {"presets": device.ptz_presets(onvif_cfg.get("profile_token") or None)}

    try:
        return _executor.submit(work).result(timeout=30)
    except Exception as exc:
        raise HTTPException(500, f"{type(exc).__name__}: {exc}")


# --------------------------------------------------------------------------
# Fuentes locales
# --------------------------------------------------------------------------
@router.get("/sources/local")
def local_sources():
    """Enumera cámaras USB/locales disponibles en el equipo."""
    devices = list_usb_devices()
    names = usb_device_names_windows()
    return {"devices": devices, "windows_names": names}
