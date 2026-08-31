"""Detección de movimiento (OpenCV) y detección con IA (YOLO, opcional)."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import List, Optional, Sequence, Tuple

import cv2
import numpy as np


@dataclass
class DetectionResult:
    motion: bool = False
    score: float = 0.0          # % de píxeles en movimiento (0-100)
    boxes: List[List[int]] = field(default_factory=list)   # en coords del frame original
    contours: int = 0
    label: str = "motion"
    labels: List[str] = field(default_factory=list)
    reason: str = ""            # "", "light_change", "zone_excluded", ...
    fps: float = 0.0


def _sensitivity_to_threshold(sensitivity: int) -> Tuple[int, float]:
    """Convierte sensibilidad 1-100 en umbrales del sustractor de fondo."""
    s = max(1, min(100, int(sensitivity)))
    # 100 -> varThreshold bajo (muy sensible), 1 -> alto (poco sensible)
    var_threshold = int(max(4, 180 * ((100 - s) / 100.0) ** 1.4 + 4))
    min_ratio = max(0.0002, 0.004 * ((100 - s) / 100.0))
    return var_threshold, min_ratio


class MotionDetector:
    """Sustractor de fondo MOG2 + filtro de contornos + zonas."""

    def __init__(self, cfg: dict):
        self._lock = threading.Lock()
        self.cfg: dict = {}
        self._bg: Optional[cv2.BackgroundSubtractorMOG2] = None
        self._frame_count = 0
        self._last_ts = time.time()
        self._fps = 0.0
        self.configure(cfg)

    # ---------- configuración ----------
    def configure(self, cfg: dict) -> None:
        with self._lock:
            changed = (
                self.cfg.get("detect_width") != cfg.get("detect_width")
                or self.cfg.get("sensitivity") != cfg.get("sensitivity")
                or self._bg is None
            )
            self.cfg = dict(cfg or {})
            var_threshold, min_ratio = _sensitivity_to_threshold(
                int(self.cfg.get("sensitivity", 55))
            )
            self._min_ratio = min_ratio
            if changed:
                self._bg = cv2.createBackgroundSubtractorMOG2(
                    history=500, varThreshold=var_threshold, detectShadows=False
                )
            else:
                self._bg.setVarThreshold(var_threshold)
            self._kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))

    # ---------- zonas ----------
    @staticmethod
    def _scale_zones(zones: Sequence, width: int, height: int) -> List[np.ndarray]:
        scaled = []
        for zone in zones or []:
            pts = []
            for point in zone:
                if len(point) < 2:
                    continue
                pts.append([float(point[0]) * width, float(point[1]) * height])
            if len(pts) >= 3:
                scaled.append(np.array(pts, dtype=np.int32))
        return scaled

    @staticmethod
    def _point_in_zones(px: float, py: float, zones: List[np.ndarray]) -> bool:
        for poly in zones:
            if cv2.pointPolygonTest(poly, (float(px), float(py)), False) >= 0:
                return True
        return False

    # ---------- núcleo ----------
    def process(self, frame: np.ndarray) -> DetectionResult:
        cfg = self.cfg
        width = int(cfg.get("detect_width", 640) or 640)
        h, w = frame.shape[:2]
        scale = width / float(w) if w else 1.0
        if abs(scale - 1.0) > 0.01:
            small = cv2.resize(frame, (width, int(h * scale)), interpolation=cv2.INTER_AREA)
        else:
            small = frame
        sh, sw = small.shape[:2]

        with self._lock:
            bg = self._bg
        if bg is None:
            return DetectionResult(reason="no_detector")

        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (5, 5), 0)
        mask = bg.apply(gray, learningRate=-1)
        _, mask = cv2.threshold(mask, 200, 255, cv2.THRESH_BINARY)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, self._kernel, iterations=1)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, self._kernel, iterations=2)
        mask = cv2.dilate(mask, self._kernel, iterations=2)

        min_area = int(cfg.get("min_area", 1200) or 0)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        zones = self._scale_zones(cfg.get("zones") or [], sw, sh)
        zone_mode = cfg.get("zone_mode", "include")

        boxes: List[List[int]] = []
        motion_pixels = 0
        excluded_all = True
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < min_area:
                continue
            x, y, cw, ch = cv2.boundingRect(cnt)
            cx, cy = x + cw / 2.0, y + ch / 2.0
            motion_pixels += area
            if zones:
                inside = self._point_in_zones(cx, cy, zones)
                if zone_mode == "include" and not inside:
                    continue
                if zone_mode == "exclude" and inside:
                    continue
            excluded_all = False
            if scale != 1.0:
                boxes.append(
                    [
                        int(x / scale),
                        int(y / scale),
                        int(cw / scale),
                        int(ch / scale),
                    ]
                )
            else:
                boxes.append([int(x), int(y), int(cw), int(ch)])

        ratio = motion_pixels / float(sw * sh) if sw * sh else 0.0
        score = round(ratio * 100.0, 3)

        # fps de análisis
        now = time.time()
        self._frame_count += 1
        if now - self._last_ts >= 1.0:
            self._fps = self._frame_count / (now - self._last_ts)
            self._frame_count = 0
            self._last_ts = now

        result = DetectionResult(score=score, contours=len(contours), fps=round(self._fps, 2))

        # Cambio global de luz (IR día/noche, nubes, faros): se descarta
        if ratio > 0.60:
            result.reason = "light_change"
            return result

        if zones and excluded_all:
            result.reason = "zone_excluded"
            return result

        if not boxes or ratio < self._min_ratio:
            result.reason = "below_threshold"
            return result

        result.motion = True
        result.boxes = self._merge_boxes(boxes)
        return result

    # ---------- utilidades ----------
    @staticmethod
    def _merge_boxes(boxes: List[List[int]], iou: float = 0.15, max_boxes: int = 12):
        """Agrupa cajas solapadas para no disparar 20 eventos por el mismo objeto."""
        if len(boxes) <= 1:
            return boxes[:max_boxes]

        def _iou(a, b):
            ax, ay, aw, ah = a
            bx, by, bw, bh = b
            x1, y1 = max(ax, bx), max(ay, by)
            x2, y2 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
            inter = max(0, x2 - x1) * max(0, y2 - y1)
            union = float(aw * ah + bw * bh - inter)
            return inter / union if union else 0.0

        merged: List[List[int]] = []
        for box in sorted(boxes, key=lambda b: b[2] * b[3], reverse=True):
            hit = False
            for m in merged:
                if _iou(box, m) > iou:
                    x1 = min(m[0], box[0])
                    y1 = min(m[1], box[1])
                    x2 = max(m[0] + m[2], box[0] + box[2])
                    y2 = max(m[1] + m[3], box[1] + box[3])
                    m[0], m[1], m[2], m[3] = x1, y1, x2 - x1, y2 - y1
                    hit = True
                    break
            if not hit:
                merged.append(list(box))
            if len(merged) >= max_boxes:
                break
        return merged

    def reset(self) -> None:
        with self._lock:
            if self._bg is not None:
                self._bg.clear()


# --------------------------------------------------------------------------
# Detección con IA (opcional, requiere `pip install ultralytics`)
# --------------------------------------------------------------------------
class AIDetector:
    """YOLOv8 vía ultralytics. Si no está instalado, `available` es False."""

    COCO = {
        0: "person", 1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck",
        14: "bird", 15: "cat", 16: "dog", 17: "horse", 18: "sheep", 19: "cow",
    }

    def __init__(self, model_name: str = "yolov8n.pt", conf: float = 0.45, labels=None):
        self.model_name = model_name
        self.conf = conf
        self.labels = set(labels or ["person", "car", "truck", "dog", "cat"])
        self.available = False
        self._model = None
        self._lock = threading.Lock()
        self.error = ""
        self._load()

    def _load(self) -> bool:
        try:
            from ultralytics import YOLO  # type: ignore
        except Exception as exc:
            self.error = f"ultralytics no instalado ({exc.__class__.__name__})"
            self.available = False
            return False
        try:
            self._model = YOLO(self.model_name)
            self.available = True
            return True
        except Exception as exc:
            self.error = f"No se pudo cargar {self.model_name}: {exc}"
            self.available = False
            return False

    def configure(self, model_name: str, conf: float, labels) -> None:
        reload = model_name != self.model_name
        self.model_name = model_name
        self.conf = float(conf)
        self.labels = set(labels or self.labels)
        if reload:
            self._load()

    def process(self, frame: np.ndarray, every_n: int = 3, counter: int = 0):
        """Devuelve (hay_objetivo, boxes, labels). Se ejecuta cada `every_n` frames."""
        if not self.available or self._model is None:
            return False, [], []
        if every_n > 1 and (counter % every_n) != 0:
            return False, [], []
        try:
            with self._lock:
                results = self._model.predict(
                    frame, conf=self.conf, verbose=False, imgsz=640
                )
        except Exception:
            return False, [], []
        boxes, labels = [], []
        for res in results:
            for box in getattr(res, "boxes", []):
                cls_id = int(box.cls[0]) if box.cls is not None else -1
                label = (
                    res.names.get(cls_id, str(cls_id))
                    if hasattr(res, "names")
                    else self.COCO.get(cls_id, str(cls_id))
                )
                if self.labels and label not in self.labels:
                    continue
                x1, y1, x2, y2 = [int(v) for v in box.xyxy[0].tolist()]
                boxes.append([x1, y1, x2 - x1, y2 - y1])
                labels.append(label)
        return bool(boxes), boxes, labels
