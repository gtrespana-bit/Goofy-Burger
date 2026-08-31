"""Cliente ONVIF opcional (requiere ``pip install onvif-zeep``).

Aporta lo que el RTSP a secas no puede: listar perfiles, pedir la URL exacta
del stream, sacar snapshots y — sobre todo — controlar PTZ (movimiento,
zoom, presets).
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

try:  # La dependencia es opcional
    from onvif import ONVIFCamera  # type: ignore

    ONVIF_AVAILABLE = True
    ONVIF_IMPORT_ERROR = ""
except Exception as exc:  # pragma: no cover - depende del entorno
    ONVIFCamera = None  # type: ignore
    ONVIF_AVAILABLE = False
    ONVIF_IMPORT_ERROR = str(exc)


class OnvifError(RuntimeError):
    pass


class OnvifDevice:
    def __init__(self, host: str, port: int = 80, username: str = "", password: str = ""):
        self.host = host.split(":")[0] if ":" in host and not host.startswith("[") else host
        self.port = int(port or 80)
        self.username = username
        self.password = password
        self.cam = None
        self.media = None
        self.ptz = None
        self.imaging = None
        self._profile_token: Optional[str] = None

    # ---------- conexión ----------
    def connect(self, wsdl_dir: Optional[str] = None) -> bool:
        if not ONVIF_AVAILABLE:
            raise OnvifError(
                f"ONVIF no disponible. Instala la dependencia con "
                f"'pip install onvif-zeep'. Detalle: {ONVIF_IMPORT_ERROR}"
            )
        try:
            self.cam = ONVIFCamera(
                self.host, self.port, self.username, self.password, wsdl_dir=wsdl_dir
            )
            self.media = self.cam.create_media_service()
        except Exception as exc:
            raise OnvifError(f"No se pudo conectar a {self.host}:{self.port} ({exc})")
        return True

    def _ensure(self):
        if self.cam is None:
            self.connect()

    # ---------- perfiles ----------
    def profiles(self) -> List[Dict[str, Any]]:
        self._ensure()
        out: List[Dict[str, Any]] = []
        for profile in self.media.GetProfiles():
            vec = getattr(profile, "VideoEncoderConfiguration", None)
            res = getattr(vec, "Resolution", None) if vec else None
            out.append(
                {
                    "token": getattr(profile, "token", ""),
                    "name": getattr(profile, "Name", "") or getattr(profile, "token", ""),
                    "width": int(getattr(res, "Width", 0) or 0),
                    "height": int(getattr(res, "Height", 0) or 0),
                    "fps": int(getattr(vec, "RateControl", None).FrameRateLimit)
                    if vec and getattr(vec, "RateControl", None)
                    else 0,
                    "encoding": str(getattr(vec, "Encoding", "") or "") if vec else "",
                    "has_ptz": bool(getattr(profile, "PTZConfiguration", None)),
                }
            )
        return out

    def stream_uri(self, profile_token: Optional[str] = None, protocol: str = "RTSP") -> str:
        self._ensure()
        token = profile_token or self._default_token()
        req = self.media.create_type("GetStreamUri")
        req.StreamSetup = {
            "Stream": "RTP-Unicast",
            "Transport": {"Protocol": protocol},
        }
        req.ProfileToken = token
        result = self.media.GetStreamUri(req)
        return getattr(result, "Uri", "") or ""

    def snapshot_uri(self, profile_token: Optional[str] = None) -> str:
        self._ensure()
        token = profile_token or self._default_token()
        try:
            result = self.media.GetSnapshotUri({"ProfileToken": token})
            return getattr(result, "Uri", "") or ""
        except Exception:
            return ""

    def profiles_with_streams(self, protocol: str = "RTSP") -> List[Dict[str, Any]]:
        """Perfiles ONVIF, cada uno enriquecido con su URL RTSP y snapshot.

        En las cámaras iCSee/XMEye **multi-lente** cada lente suele aparecer
        como un perfil de medios independiente, con su propia URL RTSP. Esto es
        la vía fiable para detectarlas todas (más fiable que los canales RTSP).
        """
        profiles = self.profiles()
        out = []
        for profile in profiles:
            token = profile["token"]
            entry = dict(profile)
            try:
                entry["rtsp"] = self.stream_uri(token, protocol=protocol)
            except Exception:
                entry["rtsp"] = ""
            try:
                entry["snapshot"] = self.snapshot_uri(token)
            except Exception:
                entry["snapshot"] = ""
            out.append(entry)
        return out

    def _default_token(self) -> str:
        if self._profile_token:
            return self._profile_token
        profiles = self.profiles()
        if not profiles:
            raise OnvifError("El dispositivo no expone perfiles de vídeo")
        self._profile_token = profiles[0]["token"]
        return self._profile_token

    # ---------- PTZ ----------
    def _ptz_service(self):
        self._ensure()
        if self.ptz is None:
            try:
                self.ptz = self.cam.create_ptz_service()
            except Exception as exc:
                raise OnvifError(f"Este dispositivo no expone PTZ ({exc})")
        return self.ptz

    def ptz_move(self, pan: float = 0.0, tilt: float = 0.0, zoom: float = 0.0,
                 duration: float = 0.4, profile_token: Optional[str] = None) -> None:
        ptz = self._ptz_service()
        token = profile_token or self._default_token()
        req = ptz.create_type("ContinuousMove")
        req.ProfileToken = token
        req.Velocity = {"PanTilt": {"x": float(pan), "y": float(tilt)}}
        try:
            req.Velocity["Zoom"] = {"x": float(zoom)}
        except Exception:
            pass
        ptz.ContinuousMove(req)
        if duration and duration > 0:
            import time

            time.sleep(max(0.05, float(duration)))
            self.ptz_stop(token)

    def ptz_relative(self, pan: float = 0.0, tilt: float = 0.0, zoom: float = 0.0,
                     speed: float = 0.5, profile_token: Optional[str] = None) -> None:
        ptz = self._ptz_service()
        token = profile_token or self._default_token()
        req = ptz.create_type("RelativeMove")
        req.ProfileToken = token
        req.Translation = {
            "PanTilt": {"x": float(pan), "y": float(tilt)},
            "Zoom": {"x": float(zoom)},
        }
        try:
            req.Speed = {
                "PanTilt": {"x": float(speed), "y": float(speed)},
                "Zoom": {"x": float(speed)},
            }
        except Exception:
            pass
        ptz.RelativeMove(req)

    def ptz_stop(self, profile_token: Optional[str] = None) -> None:
        ptz = self._ptz_service()
        token = profile_token or self._default_token()
        req = ptz.create_type("Stop")
        req.ProfileToken = token
        try:
            req.PanTilt = True
            req.Zoom = True
        except Exception:
            pass
        ptz.Stop(req)

    def ptz_presets(self, profile_token: Optional[str] = None) -> List[Dict[str, Any]]:
        ptz = self._ptz_service()
        token = profile_token or self._default_token()
        try:
            presets = ptz.GetPresets({"ProfileToken": token})
        except Exception as exc:
            raise OnvifError(f"No se pudieron leer los presets ({exc})")
        out = []
        for preset in presets or []:
            out.append(
                {
                    "token": getattr(preset, "token", ""),
                    "name": getattr(preset, "Name", "") or getattr(preset, "token", ""),
                }
            )
        return out

    def ptz_goto_preset(self, preset_token: str, profile_token: Optional[str] = None) -> None:
        ptz = self._ptz_service()
        token = profile_token or self._default_token()
        req = ptz.create_type("GotoPreset")
        req.ProfileToken = token
        req.PresetToken = preset_token
        ptz.GotoPreset(req)

    def ptz_home(self, profile_token: Optional[str] = None) -> None:
        ptz = self._ptz_service()
        token = profile_token or self._default_token()
        if hasattr(ptz, "GotoHomePosition"):
            ptz.GotoHomePosition({"ProfileToken": token})

    # ---------- info ----------
    def info(self) -> Dict[str, Any]:
        self._ensure()
        out: Dict[str, Any] = {"host": self.host, "port": self.port}
        try:
            dev = self.cam.create_devicemgmt_service()
            info = dev.GetDeviceInformation()
            out.update(
                {
                    "manufacturer": getattr(info, "Manufacturer", ""),
                    "model": getattr(info, "Model", ""),
                    "firmware": getattr(info, "FirmwareVersion", ""),
                    "serial": getattr(info, "SerialNumber", ""),
                }
            )
        except Exception:
            pass
        return out


def snapshot_bytes(host: str, port: int, username: str, password: str,
                   profile_token: Optional[str] = None):
    """Devuelve (jpeg_bytes, error) del snapshot ONVIF con la autenticación puesta."""
    import requests
    from requests.auth import HTTPDigestAuth

    device = OnvifDevice(host, port, username, password)
    device.connect()
    uri = device.snapshot_uri(profile_token)
    if not uri:
        return None, "El dispositivo no expone SnapshotUri"
    if username:
        parts = uri.split("://", 1)
        uri = f"{parts[0]}://{username}:{password}@{parts[1]}"
    try:
        resp = requests.get(
            uri, timeout=10, auth=HTTPDigestAuth(username, password) if username else None
        )
        if resp.status_code >= 300:
            return None, f"HTTP {resp.status_code}"
        return resp.content, ""
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"
