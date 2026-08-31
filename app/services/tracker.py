"""Seguimiento simple de objetos y detección de cruce de líneas.

La lógica se mantiene ligera: asocia cajas YOLO entre frames por IoU +
distancia, guarda una pequeña trayectoria por track y comprueba si el centro
del objeto cruza una línea definida (en coordenadas normalizadas 0-1).
"""

from __future__ import annotations

import math
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple


@dataclass
class TrackedBox:
    track_id: str
    label: str
    box: List[float]          # x,y,w,h en píxeles
    center: Tuple[float, float]  # centro normalizado 0-1
    confidence: float = 0.0
    age: int = 0
    hits: int = 1
    misses: int = 0
    trajectory: List[Tuple[float, float]] = field(default_factory=list)
    last_seen: float = 0.0
    last_cross: Dict[str, float] = field(default_factory=dict)


@dataclass
class Crossing:
    line_id: str
    line_name: str
    track_id: str
    label: str
    direction: str
    from_side: int
    to_side: int
    ts: float


def _iou(a: Sequence[float], b: Sequence[float]) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x1 = max(ax, bx)
    y1 = max(ay, by)
    x2 = min(ax + aw, bx + bw)
    y2 = min(ay + ah, by + bh)
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    union = float(aw * ah + bw * bh - inter)
    return inter / union if union else 0.0


def _dist(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


class ObjectTracker:
    """Tracker por IoU/distancia con soporte para líneas de cruce."""

    def __init__(self, max_age: int = 12, max_dist: float = 0.35,
                 lines: Optional[List[Dict[str, Any]]] = None,
                 line_cross_cooldown: float = 4.0):
        self.max_age = max(3, int(max_age or 12))
        self.max_dist = max(0.05, float(max_dist or 0.35))
        self.line_cross_cooldown = max(1.0, float(line_cross_cooldown or 4.0))
        self.lines: List[Dict[str, Any]] = lines or []
        self.tracks: Dict[str, TrackedBox] = {}
        self._next_id = 1
        self.current: List[TrackedBox] = []
        self.crossings: List[Crossing] = []
        self.frame_size = (0, 0)

    def configure(self, lines: Optional[List[Dict[str, Any]]] = None,
                  max_age: Optional[int] = None) -> None:
        self.lines = lines or []
        if max_age:
            self.max_age = max(3, int(max_age))
        # limpiar tracks viejos al cambiar de configuración
        now = time.time()
        self.tracks = {
            k: v for k, v in self.tracks.items()
            if now - v.last_seen < self.max_age * 2
        }

    def _all_lines(self):
        return [ln for ln in (self.lines or []) if ln.get("enabled", True)]

    def update(self, width: int, height: int, boxes: List[Sequence[float]],
               labels: List[str], confidences: Optional[List[float]] = None,
               now: Optional[float] = None) -> List[TrackedBox]:
        now = now or time.time()
        self.frame_size = (int(width), int(height))
        self.crossings = []
        if width <= 0 or height <= 0:
            return []

        # candidatos
        candidates = []
        confs = list(confidences or [])
        for i, box in enumerate(boxes[:50]):
            x, y, w, h = [float(v) for v in box[:4]]
            cx = (x + w / 2.0) / width
            cy = (y + h / 2.0) / height
            label = str(labels[i] if i < len(labels) else "object")
            conf = confs[i] if i < len(confs) else 0.0
            candidates.append({
                "box": [x, y, w, h],
                "center": (cx, cy),
                "label": label,
                "conf": conf,
            })

        # match por IoU + distancia + tipo
        updated_ids: set = set()
        for cand in sorted(candidates, key=lambda c: c["conf"], reverse=True):
            best_id = None
            best_score = 0.0
            for tid, tr in self.tracks.items():
                if tid in updated_ids:
                    continue
                if tr.label != cand["label"]:
                    w1, h1 = tr.box[2], tr.box[3]
                    w2, h2 = cand["box"][2], cand["box"][3]
                    if min(w1, w2) / max(1.0, max(w1, w2)) < 0.55:
                        continue
                iou = _iou(tr.box, cand["box"])
                d = _dist(tr.center, cand["center"])
                same_size = (
                    min(tr.box[2], cand["box"][2]) / max(1.0, max(tr.box[2], cand["box"][2])) >= 0.5
                    and min(tr.box[3], cand["box"][3]) / max(1.0, max(tr.box[3], cand["box"][3])) >= 0.5
                )
                # prioridad al solapamiento; si el objeto se mueve rápido
                # permitimos emparejar por centro + tamaño + tipo.
                ok = iou > 0.05 or (same_size and d < self.max_dist * 0.8)
                score = iou + max(0.0, 1.0 - d / self.max_dist) * 0.4
                if ok and d < self.max_dist * 2.2 and score > best_score:
                    best_score = score
                    best_id = tid
            if best_id is not None:
                tr = self.tracks[best_id]
                tr.box = candidate_box_absolute(cand["box"])
                tr.center = cand["center"]
                tr.label = cand["label"]
                tr.confidence = cand["conf"]
                tr.hits += 1
                tr.misses = 0
                tr.age += 1
                tr.last_seen = now
                tr.trajectory.append(cand["center"])
                if len(tr.trajectory) > 30:
                    tr.trajectory = tr.trajectory[-30:]
                updated_ids.add(best_id)
            else:
                track_id = f"t{self._next_id:05d}"
                self._next_id += 1
                tr = TrackedBox(
                    track_id=track_id,
                    label=cand["label"],
                    box=candidate_box_absolute(cand["box"]),
                    center=cand["center"],
                    confidence=cand["conf"],
                    age=0,
                    hits=1,
                    misses=0,
                    trajectory=[cand["center"]],
                    last_seen=now,
                )
                self.tracks[track_id] = tr
                updated_ids.add(track_id)

        # tracks sin detección en este frame
        for tid in list(self.tracks.keys()):
            tr = self.tracks[tid]
            if tid in updated_ids:
                continue
            tr.misses += 1
            tr.age += 1
            if tr.misses > self.max_age:
                self.tracks.pop(tid, None)

        # cruces de línea
        active = []
        for tr in list(self.tracks.values()):
            if len(tr.trajectory) < 2:
                active.append(tr)
                continue
            prev = tr.trajectory[-2]
            cur = tr.trajectory[-1]
            for line in self._all_lines():
                line_id = str(line.get("id") or "")
                if not line_id:
                    continue
                last = tr.last_cross.get(line_id, 0.0)
                if now - last < self.line_cross_cooldown:
                    continue
                prev_for_line = prev
                if len(tr.trajectory) >= 3 and side_of(line, prev_for_line) == 0:
                    prev_for_line = tr.trajectory[-3]
                cross = self._check_cross(line, prev_for_line, cur)
                if cross:
                    tr.last_cross[line_id] = now
                    self.crossings.append(Crossing(
                        line_id=line_id,
                        line_name=str(line.get("name") or line_id),
                        track_id=tr.track_id,
                        label=tr.label,
                        direction=cross,
                        from_side=side_of(line, prev),
                        to_side=side_of(line, cur),
                        ts=now,
                    ))
            active.append(tr)

        self.current = active
        return self.current

    def _check_cross(self, line: Dict[str, Any],
                     prev: Tuple[float, float],
                     cur: Tuple[float, float]) -> Optional[str]:
        p1 = line.get("p1") or []
        p2 = line.get("p2") or []
        if len(p1) < 2 or len(p2) < 2:
            return None
        s1 = side_of(line, prev)
        s2 = side_of(line, cur)
        if s1 == 0 or s2 == 0:
            return None
        if s1 == s2:
            return None
        direction = str(line.get("direction") or "both").lower()
        # in = entra hacia el lado positivo; out = sale hacia el negativo.
        crossing = "out" if (s1 > 0 and s2 < 0) else "in"
        if direction == "both":
            return crossing
        if direction == "in" and crossing == "in":
            return crossing
        if direction == "out" and crossing == "out":
            return crossing
        return None


def side_of(line: Dict[str, Any], point: Tuple[float, float]) -> int:
    p1 = line.get("p1") or [0, 0]
    p2 = line.get("p2") or [0, 0]
    x1, y1 = p1[0], p1[1]
    x2, y2 = p2[0], p2[1]
    px, py = point
    val = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)
    if abs(val) < 1e-9:
        return 0
    return 1 if val > 0 else -1


def candidate_box_absolute(box: List[float]) -> List[float]:
    return [float(v) for v in box]
