"""Gestor del ciclo de vida de las cámaras."""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Dict, List, Optional



from ..config import config

from .notifier import Notifier
from .retention import prune
from .worker import CameraWorker

log = logging.getLogger("vigia.manager")


class CameraManager:
    def __init__(self):
        self.workers: Dict[str, CameraWorker] = {}
        self.notifier = Notifier(lambda: config.section("notifications"))
        self._lock = threading.RLock()
        self._prune_thread: Optional[threading.Thread] = None
        self._stop = threading.Event()

    # ------------------------------------------------------------------
    # ciclo de vida
    # ------------------------------------------------------------------
    def start_all(self) -> None:
        for cam in config.cameras():
            if cam.get("enabled", True):
                self.start(cam)
        self._start_prune_loop()

    def stop_all(self) -> None:
        self._stop.set()
        with self._lock:
            workers = list(self.workers.values())
            self.workers.clear()
        for worker in workers:
            try:
                worker.stop(timeout=4.0)
            except Exception:
                log.exception("Error deteniendo worker")

    def sync(self, cameras: List[Dict[str, Any]]) -> None:
        """Arranca/para/recarga workers según la configuración actual."""
        with self._lock:
            wanted = {c["id"]: c for c in cameras if c.get("enabled", True)}
            current = set(self.workers)
            for cam_id in current - set(wanted):
                worker = self.workers.pop(cam_id)
                threading.Thread(
                    target=worker.stop, kwargs={"timeout": 4.0}, daemon=True
                ).start()
            for cam_id, cam in wanted.items():
                worker = self.workers.get(cam_id)
                if worker is None:
                    self.start(cam)
                elif worker.is_alive():
                    try:
                        worker.apply_config(cam)
                    except Exception:
                        log.exception("Error aplicando configuración a %s", cam_id)

    def start(self, camera: Dict[str, Any]) -> bool:
        with self._lock:
            existing = self.workers.get(camera["id"])
            if existing and existing.is_alive():
                return True
            worker = CameraWorker(camera, self.notifier)
            self.workers[camera["id"]] = worker
            worker.start()
            return True

    def stop(self, camera_id: str) -> bool:
        with self._lock:
            worker = self.workers.pop(camera_id, None)
        if worker is None:
            return False
        threading.Thread(target=worker.stop, kwargs={"timeout": 4.0}, daemon=True).start()
        return True

    def restart(self, camera_id: str) -> bool:
        cam = config.get_camera(camera_id)
        if not cam:
            return False
        self.stop(camera_id)
        time.sleep(0.6)
        if cam.get("enabled", True):
            self.start(cam)
        return True

    def worker(self, camera_id: str) -> Optional[CameraWorker]:
        with self._lock:
            return self.workers.get(camera_id)

    # ------------------------------------------------------------------
    # estado
    # ------------------------------------------------------------------
    def status(self, camera_id: str) -> Dict[str, Any]:
        worker = self.worker(camera_id)
        if worker is None:
            return {"state": "stopped", "recording": False, "fps": 0.0}
        status = dict(worker.status)
        status["uptime"] = int(time.time() - status.get("started_at", time.time()))
        status["frame_age"] = round(time.time() - status.get("last_frame", 0), 1)
        return status

    def all_status(self) -> Dict[str, Dict[str, Any]]:
        return {cid: self.status(cid) for cid in self.workers.keys()}

    def cameras_with_status(self) -> List[Dict[str, Any]]:
        cameras = config.cameras()
        for cam in cameras:
            cam["health"] = self.status(cam["id"])
            cam["state"] = cam["health"].get("state", "stopped")
        return cameras

    # ------------------------------------------------------------------
    # utilidades
    # ------------------------------------------------------------------
    def snapshot(self, camera_id: str, timeout: float = 6.0):
        """Último frame en memoria; si no hay, abre la fuente y lee uno."""
        worker = self.worker(camera_id)
        if worker is not None:
            frame = worker.snapshot_now()
            if frame is not None:
                return frame
        cam = config.get_camera(camera_id)
        if not cam:
            return None
        from .capture import probe_snapshot

        ok, frame, _ = probe_snapshot(cam, timeout=timeout)
        return frame if ok else None

    def start_recording_now(self, camera_id: str, seconds: int = 60) -> bool:
        """Fuerza un clip manual (aunque la cámara esté en modo continuo)."""
        worker = self.worker(camera_id)
        if worker is None:
            return False
        if worker.clip is None:
            from .recorder import ClipRecorder
            from ..config import clips_dir
            from ..models import slugify

            det = worker.camera.get("detection") or {}
            rec = worker.camera.get("recording") or {}
            worker.clip = ClipRecorder(
                worker.camera,
                clips_dir() / slugify(camera_id),
                fps=max(8.0, float(det.get("fps", 6))),
                pre_seconds=0,
                post_seconds=max(2, seconds),
                quality=rec.get("quality", "medium"),
                crf=rec.get("crf", 23),
                preset=rec.get("preset", "veryfast"),
                width=int(rec.get("width", 0) or 0),
                height=int(rec.get("height", 0) or 0),
            )
        worker.clip.trigger()
        return True

    # ------------------------------------------------------------------
    # limpieza periódica
    # ------------------------------------------------------------------
    def _start_prune_loop(self) -> None:
        if self._prune_thread and self._prune_thread.is_alive():
            return

        def loop():
            while not self._stop.is_set():
                interval = max(
                    5, int(config.section("storage").get("prune_interval_minutes", 30))
                )
                if self._stop.wait(interval * 60):
                    break
                try:
                    result = prune()
                    if result.get("files"):
                        log.info("Retención: %s ficheros liberados", result["files"])
                except Exception:
                    log.exception("Error en la limpieza periódica")

        self._prune_thread = threading.Thread(target=loop, daemon=True, name="prune")
        self._prune_thread.start()

    def prune_now(self) -> Dict:
        return prune()


manager = CameraManager()
