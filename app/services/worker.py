"""Worker por cámara: captura → detección → grabación → eventos → alertas.

Un hilo por cámara. Lee frames de la fuente, los publica en el bus (para el
directo), analiza movimiento, decide si grabar y genera eventos.
"""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import cv2
import numpy as np

from .. import events_store
from ..config import DATA_DIR, clips_dir, config, recordings_dir, snapshots_dir
from ..models import slugify
from ..events_store import make_event
from .capture import build_source
from .detector import AIDetector, MotionDetector
from .framebus import frame_bus
from .recorder import ClipRecorder, SegmentRecorder

log = logging.getLogger("vigia.worker")

PREVIEW_FPS = 12          # fps máximos publicados al visor
PREVIEW_QUALITY = 72      # calidad JPEG del directo
SNAPSHOT_QUALITY = 88


def draw_boxes(frame: np.ndarray, boxes: List[List[int]], color=(60, 200, 255),
               thickness: int = 2) -> np.ndarray:
    out = frame
    for box in boxes[:20]:
        x, y, w, h = [int(v) for v in box]
        cv2.rectangle(out, (x, y), (x + w, y + h), color, thickness)
    return out


class CameraWorker(threading.Thread):
    def __init__(self, camera: Dict[str, Any], notifier):
        super().__init__(daemon=True, name=f"cam-{camera.get('id', '?')[:10]}")
        self.camera: Dict[str, Any] = dict(camera)
        self.notifier = notifier
        self.stop_event = threading.Event()
        self.source = None
        self.detector = MotionDetector(camera.get("detection") or {})
        self.ai: Optional[AIDetector] = None
        self._ai_frame = 0
        self.segment: Optional[SegmentRecorder] = None
        self.clip: Optional[ClipRecorder] = None
        self.status: Dict[str, Any] = {
            "state": "starting",
            "fps": 0.0,
            "detect_fps": 0.0,
            "resolution": "",
            "last_frame": 0.0,
            "last_event": None,
            "last_error": "",
            "recording": False,
            "events": 0,
            "started_at": time.time(),
            "reconnects": 0,
        }
        self._ai_warned = False
        self._setup_recorders()

    # ------------------------------------------------------------------
    # configuración
    # ------------------------------------------------------------------
    @property
    def id(self) -> str:
        return self.camera.get("id", "")

    def _recordings_dir(self) -> Path:
        return recordings_dir() / slugify(self.id)

    def _clips_dir(self) -> Path:
        return clips_dir() / slugify(self.id)

    def _setup_recorders(self) -> None:
        rec = self.camera.get("recording") or {}
        mode = rec.get("mode", "continuous")
        # continua
        if mode == "continuous":
            if self.segment is None:
                self.segment = SegmentRecorder(
                    self.camera,
                    self.source,
                    self._recordings_dir(),
                    segment_seconds=rec.get("segment_seconds", 300),
                    codec=rec.get("codec", "copy"),
                    audio=rec.get("audio", False),
                )
            else:
                self.segment.segment_seconds = max(10, int(rec.get("segment_seconds", 300)))
                self.segment.codec = rec.get("codec", "copy")
        elif self.segment is not None:
            self.segment.stop()
            self.segment = None
        # por evento
        det = self.camera.get("detection") or {}
        if mode == "motion":
            if self.clip is None:
                self.clip = ClipRecorder(
                    self.camera,
                    self._clips_dir(),
                    fps=max(8.0, float(det.get("fps", 6))),
                    pre_seconds=rec.get("pre_seconds", 5),
                    post_seconds=rec.get("post_seconds", 10),
                )
            else:
                self.clip.pre_seconds = rec.get("pre_seconds", 5)
                self.clip.post_seconds = rec.get("post_seconds", 10)
        elif self.clip is not None:
            self.clip.stop()
            self.clip = None

    def apply_config(self, camera: Dict[str, Any]) -> None:
        """Aplica cambios de configuración en caliente."""
        prev_rec = self.camera.get("recording") or {}
        prev_src = self.camera.get("source_type"), self.camera.get("url"), \
            self.camera.get("substream_url"), self.camera.get("device_index")
        self.camera = dict(camera)
        self.detector.configure(camera.get("detection") or {})
        if self.ai is not None:
            det = camera.get("detection") or {}
            self.ai.configure(
                det.get("ai_model", "yolov8n.pt"),
                det.get("ai_confidence", 0.45),
                det.get("ai_labels", []),
            )
        new_rec = camera.get("recording") or {}
        new_src = camera.get("source_type"), camera.get("url"), \
            camera.get("substream_url"), camera.get("device_index")
        source_changed = prev_src != new_src
        mode_changed = prev_rec.get("mode") != new_rec.get("mode")
        self._setup_recorders()
        if source_changed or mode_changed:
            if self.segment is not None:
                self.segment.stop()
                self.segment.source = self.source or build_source(self.camera)
                self.segment.start()
            self.status["last_error"] = ""
            if source_changed:
                self.status["state"] = "reconnecting"
                if self.source is not None:
                    try:
                        self.source.release()
                    except Exception:
                        pass
                self.source = None

    # ------------------------------------------------------------------
    # ciclo principal
    # ------------------------------------------------------------------
    def run(self) -> None:
        log.info("Iniciando cámara %s (%s)", self.camera.get("name"), self.id)
        backoff = 1.0
        consecutive_failures = 0
        last_detect = 0.0
        last_preview = 0.0
        frames = 0
        fps_mark = time.time()
        fps_count = 0

        if self.segment is not None:
            # ffmpeg necesita conocer la fuente (URL/dispositivo) aunque aún
            # no hayamos abierto la captura para detectar movimiento.
            self.segment.source = self.segment.source or build_source(self.camera)
            ok, err = self.segment.start()
            if not ok:
                self.status["last_error"] = err
                log.warning("Grabación continua no disponible en %s: %s", self.id, err)
            else:
                log.info(
                    "Grabando %s en %s", self.camera.get("name"), self._recordings_dir()
                )

        while not self.stop_event.is_set():
            try:
                if self.source is None:
                    if not self._open_source():
                        time.sleep(min(30.0, backoff))
                        backoff = min(30.0, backoff * 1.6)
                        continue
                    backoff = 1.0
                    consecutive_failures = 0

                ok, frame = self.source.read()
                now = time.time()
                if not ok or frame is None:
                    consecutive_failures += 1
                    if consecutive_failures >= 25:
                        self.status["state"] = "reconnecting"
                        log.warning(
                            "Sin frames en %s, reconectando (%d fallos)",
                            self.id, consecutive_failures,
                        )
                        try:
                            self.source.release()
                        except Exception:
                            pass
                        self.source = None
                        consecutive_failures = 0
                        self.status["reconnects"] += 1
                    time.sleep(0.05)
                    continue

                consecutive_failures = 0
                frames += 1
                fps_count += 1
                self.status["state"] = "running"
                self.status["last_frame"] = now
                h, w = frame.shape[:2]
                if not self.status.get("resolution"):
                    self.status["resolution"] = f"{w}x{h}"
                if now - fps_mark >= 1.0:
                    self.status["fps"] = round(fps_count / (now - fps_mark), 2)
                    fps_count = 0
                    fps_mark = now

                # --- directo (preview) ---
                if now - last_preview >= 1.0 / PREVIEW_FPS:
                    frame_bus.publish(self.id, frame, quality=PREVIEW_QUALITY)
                    last_preview = now

                # --- clip por evento ---
                if self.clip is not None:
                    finished = self.clip.feed(frame)
                    if finished:
                        self._attach_clip(finished)

                # --- detección ---
                det_cfg = self.camera.get("detection") or {}
                interval = 1.0 / max(1, int(det_cfg.get("fps", 6) or 6))
                if (
                    det_cfg.get("enabled", True)
                    and self.stop_event is not None
                    and (now - last_detect) >= interval
                ):
                    last_detect = now
                    result = self.detector.process(frame)
                    self.status["detect_fps"] = result.fps
                    if result.motion:
                        self._on_motion(frame, result, now)

                # --- vigilancia de la grabación continua ---
                if self.segment is not None:
                    if self.segment.source is None:
                        self.segment.source = self.source
                    if not self.segment.is_alive():
                        self.segment.ensure_running()
                    self.status["recording"] = self.segment.is_alive()
                else:
                    self.status["recording"] = bool(self.clip and self.clip.recording)

            except Exception as exc:  # pragma: no cover - el hilo nunca debe morir
                log.exception("Error en el worker de %s", self.id)
                self.status["last_error"] = f"{type(exc).__name__}: {exc}"
                time.sleep(1.0)

        self._shutdown()
        log.info("Cámara %s detenida", self.id)

    def _open_source(self) -> bool:
        try:
            self.source = build_source(self.camera)
            if not self.source.open():
                self.status["state"] = "reconnecting"
                self.status["last_error"] = "No se pudo abrir la fuente"
                return False
        except Exception as exc:
            self.status["last_error"] = f"{type(exc).__name__}: {exc}"
            self.status["state"] = "error"
            self.source = None
            return False
        # primer frame para dimensiones
        for _ in range(15):
            ok, frame = self.source.read()
            if ok and frame is not None:
                h, w = frame.shape[:2]
                self.status["resolution"] = f"{w}x{h}"
                frame_bus.publish(self.id, frame, quality=PREVIEW_QUALITY)
                break
            time.sleep(0.1)
        if self.segment is not None:
            self.segment.source = self.source
        self.status["last_error"] = ""
        self.status["state"] = "running"
        return True

    # ------------------------------------------------------------------
    # eventos
    # ------------------------------------------------------------------
    def _ensure_ai(self) -> Optional[AIDetector]:
        det = self.camera.get("detection") or {}
        if not det.get("ai_enabled"):
            return None
        if self.ai is None:
            self.ai = AIDetector(
                det.get("ai_model", "yolov8n.pt"),
                det.get("ai_confidence", 0.45),
                det.get("ai_labels", []),
            )
            if not self.ai.available and not self._ai_warned:
                self._ai_warned = True
                log.warning(
                    "IA solicitada pero no disponible (%s). Instala: pip install ultralytics",
                    self.ai.error,
                )
        return self.ai if (self.ai and self.ai.available) else None

    def _on_motion(self, frame: np.ndarray, result, now: float) -> None:
        det = self.camera.get("detection") or {}
        label = "motion"
        boxes = result.boxes

        ai = self._ensure_ai()
        if ai is not None:
            self._ai_frame += 1
            hit, ai_boxes, ai_labels = ai.process(frame, every_n=1, counter=self._ai_frame)
            if not hit:
                # con IA activa exigimos que confirme un objeto de interés
                return
            label = ai_labels[0] if ai_labels else "object"
            boxes = ai_boxes

        cooldown = float(det.get("cooldown_seconds", 20) or 0)
        last = self.status.get("last_event")
        if last and (now - last) < cooldown:
            if self.clip is not None:
                self.clip.extend()
            return
        self.status["last_event"] = now

        rel_snapshot = self._save_snapshot(frame, boxes, label)
        event = make_event(
            self.camera, label, result.score, boxes, snapshot_rel=rel_snapshot
        )
        events_store.add(event)
        self.status["events"] += 1
        self.status["last_event_iso"] = event["ts"]

        # grabación por evento
        if self.clip is not None:
            self.clip.trigger()
            self._clip_event_id = event["id"]

        self._notify(event, rel_snapshot)

    _clip_event_id: Optional[str] = None

    def _attach_clip(self, path: str) -> None:
        try:
            rel = str(Path(path).resolve().relative_to(DATA_DIR.resolve()))
        except Exception:
            rel = path
        event_id = self._clip_event_id
        self._clip_event_id = None
        if event_id:
            events_store.update(event_id, {"clip": rel})
        else:
            # clip sin evento previo (post-roll): lo dejamos registrado igualmente
            events_store.add(
                make_event(self.camera, "motion", 0.0, [], clip_rel=rel)
            )

    def _save_snapshot(self, frame: np.ndarray, boxes, label: str) -> str:
        try:
            day = time.strftime("%Y%m%d")
            folder = snapshots_dir() / slugify(self.id) / day
            folder.mkdir(parents=True, exist_ok=True)
            name = f"{time.strftime('%Y%m%dT%H%M%S')}_{label}.jpg"
            path = folder / name
            img = draw_boxes(frame.copy(), boxes)
            cv2.imwrite(str(path), img, [int(cv2.IMWRITE_JPEG_QUALITY), SNAPSHOT_QUALITY])
            return str(path.resolve().relative_to(DATA_DIR.resolve()))
        except Exception as exc:
            log.warning("No se pudo guardar snapshot: %s", exc)
            return ""

    def _notify(self, event: Dict[str, Any], snapshot_rel: str) -> None:
        alerts = self.camera.get("alerts") or {}
        if not alerts.get("enabled", True):
            return
        notif_cfg = config.section("notifications")
        if not notif_cfg.get("enabled", True):
            return
        general = config.section("general")
        if alerts.get("only_when_away") and not general.get("away"):
            return
        cooldown = float(notif_cfg.get("cooldown_seconds", 60) or 0)
        now = time.time()
        if cooldown and (now - getattr(self, "_last_notified", 0.0)) < cooldown:
            return
        self._last_notified = now

        image = DATA_DIR / snapshot_rel if snapshot_rel else None
        title = f"🎥 {self.camera.get('name', 'Cámara')}: {event['label']}"
        body = (
            f"{event['ts'].replace('T', ' ').replace('Z', '')}\n"
            f"Confianza: {event['score']}% de imagen en movimiento"
        )
        channels = alerts.get("channels") or None
        try:
            future = self.notifier.send_async(title, body, image, channels)
            future.add_done_callback(
                lambda f: self._notified_cb(event, f)
            )
        except Exception as exc:
            log.warning("Error enviando notificación: %s", exc)

    def _notified_cb(self, event: Dict[str, Any], future) -> None:
        try:
            results = future.result(timeout=1) or {}
        except Exception as exc:
            results = {"error": str(exc)}
        sent = [name for name, res in results.items() if res in ("ok", "")]
        if sent:
            events_store.update(
                event["id"], {"notified": sorted(set(event.get("notified", []) + sent))}
            )
        failed = {k: v for k, v in results.items() if v and v != "ok"}
        if failed:
            self.status["last_notify_error"] = str(failed)[:200]

    # ------------------------------------------------------------------
    # cierre
    # ------------------------------------------------------------------
    def _shutdown(self) -> None:
        if self.segment is not None:
            self.segment.stop()
            self.segment = None
        if self.clip is not None:
            try:
                path = self.clip.stop()
                if path:
                    self._attach_clip(path)
            except Exception:
                pass
            self.clip = None
        if self.source is not None:
            try:
                self.source.release()
            except Exception:
                pass
            self.source = None
        frame_bus.drop(self.id)
        self.status["state"] = "stopped"
        self.status["recording"] = False

    def stop(self, timeout: float = 5.0) -> None:
        self.stop_event.set()
        self.join(timeout=timeout)

    def snapshot_now(self):
        """Devuelve el último frame conocido (o None)."""
        slot = frame_bus.slot(self.id)
        with slot.cond:
            return None if slot.frame is None else slot.frame.copy()
