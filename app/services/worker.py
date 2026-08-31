"""Worker por cámara: captura → detección → grabación → eventos → alertas.

Un hilo por cámara. Lee frames de la fuente, los publica en el bus (para el
directo), analiza movimiento, decide si grabar y genera eventos.
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import cv2
import numpy as np

from .. import events_store
from ..config import DATA_DIR, clips_dir, config, recordings_dir, snapshots_dir
from ..models import is_schedule_active, slugify
from ..events_store import make_event
from .capture import build_source
from .detector import AIDetector, MotionDetector
from .framebus import frame_bus
from .pusher import send_push
from .recorder import ClipRecorder, SegmentRecorder
from .tracker import ObjectTracker

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
        self.tracker: Optional[ObjectTracker] = None
        self._analytics_warned = False
        self._last_line_event = 0.0
        self._line_event_times: List[float] = []
        self._line_last: Dict[str, float] = {}
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
            "tracks": 0,
            "started_at": time.time(),
            "reconnects": 0,
        }
        self._ai_warned = False
        self._last_notified = 0.0
        self._last_logged_error = ""
        self._notify_times = []
        self._tamper_since = 0.0
        self._last_tamper_event = 0.0
        self._tamper_ok_since = 0.0
        self._setup_recorders()
        det0 = self.camera.get("detection") or {}
        ana0 = det0.get("analytics") or {}
        self.tracker = ObjectTracker(
            max_age=int(ana0.get("max_track_age", 12) or 12),
            max_dist=0.4,
            lines=ana0.get("lines") or [],
            line_cross_cooldown=float(ana0.get("line_cross_cooldown", 4) or 4),
        )

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
        continuous_modes = {"continuous", "smart", "scheduled"}
        if mode in continuous_modes:
            if self.segment is None:
                self.segment = SegmentRecorder(
                    self.camera,
                    self.source,
                    self._recordings_dir(),
                    segment_seconds=rec.get("segment_seconds", 300),
                    codec=rec.get("codec", "copy"),
                    audio=rec.get("audio", False),
                    quality=rec.get("quality", "medium"),
                    crf=rec.get("crf", 23),
                    preset=rec.get("preset", "veryfast"),
                    bitrate=rec.get("bitrate", ""),
                    width=int(rec.get("width", 0) or 0),
                    height=int(rec.get("height", 0) or 0),
                    fps=int(rec.get("fps", 0) or 0),
                )
            else:
                for k in ("segment_seconds", "codec", "audio", "quality", "crf",
                          "preset", "bitrate", "width", "height", "fps"):
                    if k == "segment_seconds":
                        self.segment.segment_seconds = max(10, int(rec.get(k, 300)))
                    else:
                        setattr(self.segment, k, rec.get(k, getattr(self.segment, k)))
        elif self.segment is not None:
            self.segment.stop()
            self.segment = None
        # por evento
        det = self.camera.get("detection") or {}
        if mode in ("motion", "smart"):
            if self.clip is None:
                self.clip = ClipRecorder(
                    self.camera,
                    self._clips_dir(),
                    fps=max(8.0, float(det.get("fps", 6))),
                    pre_seconds=rec.get("pre_seconds", 5),
                    post_seconds=rec.get("post_seconds", 10),
                    max_seconds=rec.get("max_event_seconds", 600),
                    quality=rec.get("quality", "medium"),
                    crf=rec.get("crf", 23),
                    preset=rec.get("preset", "veryfast"),
                    width=int(rec.get("width", 0) or 0),
                    height=int(rec.get("height", 0) or 0),
                )
            else:
                self.clip.pre_seconds = rec.get("pre_seconds", 5)
                self.clip.post_seconds = rec.get("post_seconds", 10)
                self.clip.max_seconds = max(30.0, float(rec.get("max_event_seconds", 600)))
        elif self.clip is not None:
            self.clip.stop()
            self.clip = None

    def apply_config(self, camera: Dict[str, Any]) -> None:
        """Aplica cambios de configuración en caliente."""
        prev_rec = self.camera.get("recording") or {}
        prev_src = self.camera.get("source_type"), self.camera.get("url"), \
            self.camera.get("substream_url"), self.camera.get("device_index")
        self.camera = dict(camera)
        det = camera.get("detection") or {}
        self.detector.configure(det)
        analytics = det.get("analytics") or {}
        if self.tracker is None:
            self.tracker = ObjectTracker(
                max_age=int(analytics.get("max_track_age", 12) or 12),
                max_dist=0.4,
                lines=analytics.get("lines") or [],
                line_cross_cooldown=float(analytics.get("line_cross_cooldown", 4) or 4),
            )
        else:
            self.tracker.configure(
                lines=analytics.get("lines") or [],
                max_age=int(analytics.get("max_track_age", 12) or 12),
            )
            self.tracker.line_cross_cooldown = float(
                analytics.get("line_cross_cooldown", 4) or 4
            )
        if self.ai is not None:
            self.ai.configure(
                det.get("ai_model", "yolov8n.pt"),
                det.get("ai_confidence", 0.45),
                det.get("ai_labels", []),
                imgsz=int(det.get("ai_imgsz", 640) or 640),
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
        backoff = 5.0
        no_frame_backoff = 1.0
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
                        time.sleep(min(60.0, backoff))
                        backoff = min(60.0, backoff * 1.8)
                        continue
                    backoff = 2.0
                    no_frame_backoff = 1.0
                    consecutive_failures = 0

                ok, frame = self.source.read()
                now = time.time()
                if not ok or frame is None:
                    consecutive_failures += 1
                    if consecutive_failures == 1:
                        # La fuente abrió pero no entrega fotogramas. Lo marcamos
                        # antes del umbral para que el usuario lo vea en la UI.
                        self.status["state"] = "reconnecting"
                        self.status["last_error"] = (
                            getattr(self.source, "last_error", "")
                            or "La fuente abrió pero no envía fotogramas"
                        )
                    if consecutive_failures >= 25:
                        err = (
                            getattr(self.source, "last_error", "")
                            or "La fuente abrió pero no envía fotogramas"
                        )
                        self.status["state"] = "reconnecting"
                        self.status["last_error"] = err
                        if err != self._last_logged_error:
                            self._last_logged_error = err
                            log.warning(
                                "Sin frames en %s, reconectando (%d fallos): %s",
                                self.id, consecutive_failures, err,
                            )
                        try:
                            self.source.release()
                        except Exception:
                            pass
                        self.source = None
                        consecutive_failures = 0
                        self.status["reconnects"] += 1
                        time.sleep(no_frame_backoff)
                        no_frame_backoff = min(30.0, no_frame_backoff * 1.8)
                    time.sleep(0.05)
                    continue

                consecutive_failures = 0
                no_frame_backoff = 1.0
                self.status["last_error"] = ""
                self._last_logged_error = ""
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

                # --- directo (preview), con overlay premium si está activo ---
                visible = None
                if now - last_preview >= 1.0 / PREVIEW_FPS:
                    visible = self._apply_overlay(frame)
                    frame_bus.publish(self.id, visible, quality=PREVIEW_QUALITY)
                    last_preview = now

                # --- clip por evento (se graba la imagen tal y como se ve) ---
                if self.clip is not None:
                    if visible is None:
                        visible = self._apply_overlay(frame)
                    finished = self.clip.feed(visible)
                    if finished:
                        self._attach_clip(finished)

                # --- detección (se analiza la imagen original, sin overlay) ---
                det_cfg = self.camera.get("detection") or {}
                detection_active = det_cfg.get("enabled", True) and is_schedule_active(
                    det_cfg.get("schedule"), now=datetime.now()
                )
                interval = 1.0 / max(1, int(det_cfg.get("fps", 6) or 6))
                if (
                    detection_active
                    and self.stop_event is not None
                    and (now - last_detect) >= interval
                ):
                    last_detect = now
                    result = self.detector.process(frame)
                    self.status["detect_fps"] = result.fps
                    ai_hit, ai_boxes, ai_labels, ai_confs = False, [], [], []
                    if det_cfg.get("ai_enabled"):
                        ai_hit, ai_boxes, ai_labels, ai_confs = self._predict_ai(frame, det_cfg)
                    if result.motion:
                        if visible is None:
                            visible = self._apply_overlay(frame)
                        self._on_motion(
                            frame, result, now, snapshot_frame=visible,
                            ai_hit=ai_hit, ai_boxes=ai_boxes,
                            ai_labels=ai_labels, ai_confs=ai_confs,
                        )
                    if visible is None:
                        visible = self._apply_overlay(frame)
                    self._run_analytics(
                        frame, visible, result, now,
                        ai_hit=ai_hit, ai_boxes=ai_boxes,
                        ai_labels=ai_labels, ai_confs=ai_confs,
                    )

                # --- detección de manipulación / cámara tapada ---
                if det_cfg.get("tamper_enabled") and detection_active:
                    tamper_view = visible if visible is not None else self._apply_overlay(frame)
                    self._check_tamper(frame, tamper_view, now)

                # --- vigilancia de la grabación continua ---
                recording_active = self._recording_wanted(now)
                if self.segment is not None:
                    if self.segment.source is None:
                        self.segment.source = self.source
                    if recording_active:
                        if not self.segment.is_alive():
                            self.segment.ensure_running()
                    elif self.segment.is_alive():
                        self.segment.stop()
                    self.status["recording"] = bool(recording_active and self.segment.is_alive())
                else:
                    self.status["recording"] = bool(self.clip and self.clip.recording)

                if recording_active and not self.status.get("recording") and self.segment is not None:
                    self.segment.ensure_running()

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
                err = getattr(self.source, "last_error", "") or "No se pudo abrir la fuente"
                try:
                    self.source.release()
                except Exception:
                    pass
                self.source = None
                self.status["state"] = "reconnecting"
                self.status["last_error"] = err
                if err != self._last_logged_error:
                    self._last_logged_error = err
                    log.warning("No se pudo abrir la fuente de %s: %s", self.id, err)
                return False
        except Exception as exc:
            err = f"{type(exc).__name__}: {exc}"
            self.status["last_error"] = err
            self.status["state"] = "error"
            self.source = None
            if err != self._last_logged_error:
                self._last_logged_error = err
                log.warning("Error abriendo la fuente de %s: %s", self.id, err)
            return False
        # primer frame para dimensiones
        got_frame = False
        for _ in range(15):
            ok, frame = self.source.read()
            if ok and frame is not None:
                h, w = frame.shape[:2]
                self.status["resolution"] = f"{w}x{h}"
                frame_bus.publish(self.id, frame, quality=PREVIEW_QUALITY)
                got_frame = True
                break
            time.sleep(0.1)
        if self.segment is not None:
            self.segment.source = self.source
        if got_frame:
            self.status["last_error"] = ""
            self._last_logged_error = ""
            self.status["state"] = "running"
        else:
            # La fuente se abrió pero aún no ha entregado vídeo. No lo tratamos
            # como "conectado" para que la UI y el log lo muestren.
            self.status["last_error"] = (
                getattr(self.source, "last_error", "")
                or "La fuente abrió pero no envía fotogramas"
            )
            self.status["state"] = "reconnecting"
        return True

    # ------------------------------------------------------------------
    # utilidades premium: horario, overlay, tamper
    # ------------------------------------------------------------------
    def _recording_wanted(self, now: float) -> bool:
        rec = self.camera.get("recording") or {}
        mode = rec.get("mode", "continuous")
        if mode == "off":
            return False
        if mode in ("scheduled",):
            return is_schedule_active(rec.get("schedule"), now=datetime.now())
        # continuous, smart y motion-manual se rigen por su lógica normal.
        return True

    def _apply_overlay(self, frame: np.ndarray) -> np.ndarray:
        cfg = (self.camera.get("overlay") or {}).get("enabled") and self.camera.get("overlay") or {}
        cams = self.camera
        if not cfg or not cfg.get("enabled"):
            return frame
        try:
            out = frame.copy()
            h, w = out.shape[:2]
            scale = float(cfg.get("font_scale", 0.7) or 0.7)
            lines = []
            if cfg.get("camera_name"):
                lines.append(cams.get("name", ""))
            if cfg.get("location"):
                lines.append(cams.get("location", ""))
            if cfg.get("timestamp"):
                lines.append(datetime.now().strftime("%d/%m/%Y %H:%M:%S"))
            pos = cfg.get("position", "bottom-left")
            margin = int(10 * scale)
            line_h = int(24 * scale)
            total = line_h * len(lines) + margin
            x0 = margin if "left" in pos else w - margin
            y0 = margin if "top" in pos else h - margin - total
            for i, line in enumerate(lines):
                text = str(line)
                (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, 1)
                span = (8 * scale)
                x = x0 if "left" in pos else x0 - tw - span * 2
                y = y0 + i * line_h + int(th)
                cv2.rectangle(out, (int(x - span), int(y - th - span)),
                              (int(x + tw + span), int(y + span)), (0, 0, 0), -1)
                cv2.putText(out, text, (int(x), int(y)), cv2.FONT_HERSHEY_SIMPLEX,
                            scale, (255, 255, 255), 1, cv2.LINE_AA)
            return out
        except Exception:
            return frame

    def _check_tamper(self, frame: np.ndarray, visible: np.ndarray, now: float) -> None:
        det = self.camera.get("detection") or {}
        sensitivity = max(1, min(100, int(det.get("tamper_sensitivity", 40))))
        try:
            small = cv2.resize(frame, (256, 144), interpolation=cv2.INTER_AREA)
            gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
            mean = float(gray.mean())
            std = float(gray.std())
            tapped = mean < 5 or mean > 250 or std < 2.0
        except Exception:
            return
        limit = max(1, int(8 - sensitivity / 20))  # sensibilidad alta -> detecta antes
        if tapped:
            if self._tamper_since <= 0:
                self._tamper_since = now
            if self._tamper_since and (now - self._tamper_since) >= limit and (now - self._last_tamper_event) >= 60:
                self._last_tamper_event = now
                self._tamper_since = 0
                rel = self._save_snapshot(visible, [], "tamper")
                event = make_event(self.camera, "tamper", 0.0, [], snapshot_rel=rel)
                events_store.add(event)
                self.status["events"] += 1
                self.status["last_event_iso"] = event["ts"]
                self.status["last_event"] = now
                self._notify(event, rel)
        else:
            self._tamper_since = 0
            self._tamper_ok_since = now

    def _notify_throttled(self, now: float) -> bool:
        alerts = self.camera.get("alerts") or {}
        max_per_hour = max(0, int(alerts.get("max_per_hour", 0) or 0))
        if not max_per_hour:
            return True
        window = now - 3600
        self._notify_times = [t for t in self._notify_times if t >= window]
        if len(self._notify_times) >= max_per_hour:
            return False
        self._notify_times.append(now)
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
                imgsz=int(det.get("ai_imgsz", 640) or 640),
            )
            if not self.ai.available and not self._ai_warned:
                self._ai_warned = True
                log.warning(
                    "IA solicitada pero no disponible (%s). Instala: pip install ultralytics",
                    self.ai.error,
                )
        return self.ai if (self.ai and self.ai.available) else None

    def _predict_ai(self, frame: np.ndarray, det: Dict[str, Any]):
        ai = self._ensure_ai()
        if ai is None:
            return False, [], [], []
        self._ai_frame += 1
        every_n = max(1, int(det.get("ai_every_n", 3) or 1))
        return ai.process(frame, every_n=every_n, counter=self._ai_frame)

    def _analytics_cfg(self) -> Dict[str, Any]:
        return (self.camera.get("detection") or {}).get("analytics") or {}

    def _run_analytics(
        self, frame: np.ndarray, visible: np.ndarray, result, now: float,
        ai_hit: bool = False,
        ai_boxes: Optional[list] = None,
        ai_labels: Optional[list] = None,
        ai_confs: Optional[list] = None,
    ) -> None:
        cfg = self._analytics_cfg()
        if not cfg.get("enabled", False) or self.tracker is None:
            return
        if not cfg.get("tracking_enabled", True):
            return
        det = self.camera.get("detection") or {}
        lines = [ln for ln in (cfg.get("lines") or []) if ln.get("enabled", True)]

        boxes, labels, confs = [], [], []
        if det.get("ai_enabled"):
            if ai_hit:
                boxes = ai_boxes or []
                labels = ai_labels or []
                confs = ai_confs or []
        elif result.motion:
            boxes = result.boxes
            labels = ["object"] * len(boxes)
            confs = [0.0] * len(boxes)

        h, w = frame.shape[:2]
        if not boxes:
            self.tracker.update(w, h, [], [], [], now=now)
            self.status["tracks"] = 0
            return
        self.tracker.update(w, h, boxes, labels, confs, now=now)
        self.status["tracks"] = len(self.tracker.current)
        if (
            not cfg.get("line_crossing_enabled", True)
            or not lines
            or self.tracker is None
            or not self.tracker.crossings
        ):
            return

        # Sólo cruzamos una vez cada cooldown por línea y cámara.
        cooldown = max(0, int(cfg.get("line_cross_cooldown", 4) or 4))
        for cross in self.tracker.crossings:
            if cooldown and (now - self._last_line_event) < cooldown:
                continue
            line_event = self._make_line_event(
                visible, result, now, cross, boxes, labels, confs,
            )
            if line_event:
                self._last_line_event = now

    def _make_line_event(self, visible: np.ndarray, result, now: float, cross,
                         boxes: list, labels: list, confs: list) -> bool:
        cfg = self._analytics_cfg()
        line = next((ln for ln in (cfg.get("lines") or []) if str(ln.get("id")) == cross.line_id), None)
        if line is None:
            return False
        alert = self.camera.get("alerts") or {}
        wanted_labels = [str(x).lower() for x in (alert.get("labels") or [])]
        if wanted_labels:
            object_label = str(getattr(cross, "label", "object") or "object").lower()
            if "line_cross" not in wanted_labels and object_label not in wanted_labels:
                return False
        # cooldown por línea (evita dobles eventos inmediatos)
        key = cross.line_id
        last = self._line_last.get(key, 0.0)
        if last and (now - last) < float(cfg.get("line_cross_cooldown", 4) or 4):
            return False
        self._line_last[key] = now

        track_box: list = []
        for i, box in enumerate(boxes):
            if i < len(labels) and labels[i] == cross.label:
                track_box = list(box)
                break
        score = float(result.score or 0.0)
        if cross.label != "object":
            idx = labels.index(cross.label) if cross.label in labels else -1
            if idx >= 0 and idx < len(confs) and confs[idx]:
                # score global se expresa en porcentaje; para IA usamos confianza
                score = round(max(score, float(confs[idx]) * 100.0), 2)
        rel = self._save_snapshot(visible, [track_box] if track_box else [], "line_cross", lines=[line])
        event = make_event(
            self.camera,
            "line_cross",
            score,
            [track_box],
            snapshot_rel=rel,
            meta={
                "track_id": cross.track_id,
                "label": cross.label,
                "line_id": cross.line_id,
                "line_name": cross.line_name or cross.line_id,
                "direction": cross.direction,
                "reason": "line_cross",
            },
        )
        events_store.add(event)
        self.status["events"] += 1
        self.status["last_event_iso"] = event["ts"]
        self.status["last_event"] = now
        self._notify(event, rel)
        return True

    def _on_motion(
        self, frame: np.ndarray, result, now: float,
        snapshot_frame: Optional[np.ndarray] = None,
        ai_hit: bool = False,
        ai_boxes: Optional[list] = None,
        ai_labels: Optional[list] = None,
        ai_confs: Optional[list] = None,
    ) -> None:
        det = self.camera.get("detection") or {}
        label = "motion"
        boxes = result.boxes

        if det.get("ai_enabled"):
            if not ai_hit:
                # con IA activa exigimos que confirme un objeto de interés
                return
            label = (ai_labels or ["object"])[0]
            boxes = ai_boxes or []

        cooldown = float(det.get("cooldown_seconds", 20) or 0)
        last = self.status.get("last_event")
        if last and (now - last) < cooldown:
            if self.clip is not None:
                self.clip.extend()
            return
        self.status["last_event"] = now

        snap = snapshot_frame if snapshot_frame is not None else frame
        rel_snapshot = self._save_snapshot(snap, boxes, label)
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

    def _save_snapshot(self, frame: np.ndarray, boxes, label: str,
                       lines: Optional[list] = None) -> str:
        try:
            day = time.strftime("%Y%m%d")
            folder = snapshots_dir() / slugify(self.id) / day
            folder.mkdir(parents=True, exist_ok=True)
            name = f"{time.strftime('%Y%m%dT%H%M%S')}_{label}.jpg"
            path = folder / name
            img = draw_boxes(frame.copy(), boxes)
            if lines:
                h, w = img.shape[:2]
                for line in lines:
                    p1 = line.get("p1") or []
                    p2 = line.get("p2") or []
                    if len(p1) >= 2 and len(p2) >= 2:
                        cv2.line(
                            img,
                            (int(float(p1[0]) * w), int(float(p1[1]) * h)),
                            (int(float(p2[0]) * w), int(float(p2[1]) * h)),
                            (240, 80, 80), 2, cv2.LINE_AA,
                        )
            cv2.imwrite(str(path), img, [int(cv2.IMWRITE_JPEG_QUALITY), SNAPSHOT_QUALITY])
            return str(path.resolve().relative_to(DATA_DIR.resolve()))
        except Exception as exc:
            log.warning("No se pudo guardar snapshot: %s", exc)
            return ""

    def _notify(self, event: Dict[str, Any], snapshot_rel: str) -> None:
        alerts = self.camera.get("alerts") or {}
        if not alerts.get("enabled", True):
            return
        wanted_labels = [str(x).lower() for x in (alerts.get("labels") or [])]
        meta = event.get("meta") or {}
        event_labels = {
            str(event.get("label", "motion")).lower(),
            str(meta.get("label", "")).lower(),
            str(meta.get("object_label", "")).lower(),
        }
        if wanted_labels and not event_labels.intersection(wanted_labels):
            return
        if not self._notify_throttled(time.time()):
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
        meta = event.get("meta") or {}
        body = (
            f"{event['ts'].replace('T', ' ').replace('Z', '')}\n"
            f"Confianza: {event['score']}% de imagen en movimiento"
        )
        if meta.get("line_name"):
            body = (
                f"{event['ts'].replace('T', ' ').replace('Z', '')}\n"
                f"Línea {meta['line_name']}: {meta.get('label', 'objeto')} "
                f"cruzó hacia {meta.get('direction', 'desconocido')}\n"
                f"Objeto: {meta.get('track_id', '')} · confianza {event['score']}%"
            )

        # Web Push real al móvil (PWA instalada + HTTPS). Se lanza en un hilo
        # para no bloquear la detección esperando al servicio push.
        def _push_worker():
            try:
                send_push(title, body, "/#/events")
            except Exception as exc:
                log.warning("Push web fallido: %s", exc)
        threading.Thread(target=_push_worker, daemon=True).start()

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
