"""Dart detection from 1..n calibrated cameras.

Pipeline per evaluation (after the image has calmed down):
  1. difference image against the reference (board before the throw)
  2. the new dart is the largest changed blob inside the board region
  3. the dart axis is fitted on the tip-side part of the blob
  4. via the calibration homography the image axis is mapped onto the board plane:
     the dart tip is guaranteed to lie on this board line (it is the intersection of the
     dart with the board plane), even if the thin steel tip itself is not visible
  5. the board lines of all cameras are intersected (least squares) -> tip position
"""
from __future__ import annotations

import logging
import math
import threading
import time
import uuid
from dataclasses import dataclass

import cv2
import numpy as np

from .config import Settings
from .geometry import BOARD_RADIUS, apply_h, board_to_image_homography, circle_points, estimate_pose, project3d, score

log = logging.getLogger(__name__)

PROC_WIDTH = 640


@dataclass
class Observation:
    camera: int
    tip_board: np.ndarray  # visible tip end mapped to the board (biased if the tip is hidden)
    normal: np.ndarray  # unit normal of the board line through the tip
    offset: float  # line: normal . X = offset
    length_px: float
    area: int
    weight: float


class CameraState:
    def __init__(self, index: int, points: list[tuple[float, float]]):
        self.index = index
        self.points = points
        self.size: tuple[int, int] | None = None
        self.H: np.ndarray | None = None  # board -> proc image
        self.Hinv: np.ndarray | None = None
        self.pose: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None
        self.roi: np.ndarray | None = None
        self.ref: np.ndarray | None = None
        self.prev: np.ndarray | None = None
        self.empty: np.ndarray | None = None

    def normal_direction(self, img_pt: np.ndarray) -> np.ndarray | None:
        """Image direction in which a dart standing at img_pt points away from the board."""
        if self.pose is None:
            return None
        b = apply_h(self.Hinv, [img_pt])[0]
        K, R, t = self.pose
        p = project3d(K, R, t, [[b[0], b[1], 0.0], [b[0], b[1], 40.0]])
        d = p[1] - p[0]
        n = float(np.linalg.norm(d))
        return d / n if n > 1e-6 else None

    def prepare(self, w: int, h: int) -> bool:
        if self.size == (w, h) and self.H is not None:
            return True
        H = board_to_image_homography(self.points, w, h)
        if H is None:
            return False
        self.size = (w, h)
        self.H = H
        self.Hinv = np.linalg.inv(H)
        try:
            self.pose = estimate_pose(H, w, h)
        except Exception:  # degenerate calibration
            self.pose = None
        outline = apply_h(H, circle_points(BOARD_RADIUS * 1.04, 96)).astype(np.int32)
        roi = np.zeros((h, w), np.uint8)
        cv2.fillPoly(roi, [outline], 255)
        # darts stick out of the board towards the camera -> grow the region generously
        k = max(15, int(h * 0.22)) | 1
        self.roi = cv2.dilate(roi, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
        self.ref = self.prev = self.empty = None
        return True


def _to_gray(frame: np.ndarray, width: int) -> np.ndarray:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame
    h, w = gray.shape[:2]
    if w != width:
        gray = cv2.resize(gray, (width, int(round(h * width / w))), interpolation=cv2.INTER_AREA)
    return cv2.GaussianBlur(gray, (5, 5), 0)


class Detector:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.cams: dict[int, CameraState] = {}
        self.state = "throw"
        self.darts = 0
        self.detecting = True
        self.moving = False
        self.calm = 0
        self._pre_takeout: tuple[str, int] | None = None
        self._lock = threading.RLock()
        self.last_areas: dict[int, int] = {}
        # lighting: mean brightness per camera, "settling" until, and whether the board is too dark
        self._means: dict[int, np.ndarray] = {}
        self._light_until = 0.0
        self.dark = False

    # ------------------------------------------------------------------ control
    def set_calibration(self, index: int, points: list[tuple[float, float]] | None) -> None:
        with self._lock:
            if points is None:
                self.cams.pop(index, None)
            else:
                self.cams[index] = CameraState(index, [tuple(p) for p in points])

    def reset(self) -> None:
        with self._lock:
            for c in self.cams.values():
                c.ref = c.prev = c.empty = None
            self.darts = 0
            self.state = "throw"
            self.moving = False
            self.calm = 0
            self._pre_takeout = None

    def set_detecting(self, on: bool) -> None:
        with self._lock:
            self.detecting = on
            if on:
                self.reset()

    @property
    def calibrated(self) -> bool:
        return bool(self.cams)

    def public_state(self) -> str:
        if not self.detecting:
            return "stopped"
        if not self.cams:
            return "calibration_needed"
        return self.state

    # ------------------------------------------------------------------ main step
    def process(self, frames: dict[int, np.ndarray]) -> list[tuple]:
        """Feed the latest frame of every camera. Returns a list of events."""
        with self._lock:
            return self._process(frames)

    def _process(self, frames: dict[int, np.ndarray]) -> list[tuple]:
        s = self.settings
        events: list[tuple] = []
        grays: dict[int, np.ndarray] = {}
        for idx, cam in self.cams.items():
            frame = frames.get(idx)
            if frame is None:
                continue
            g = _to_gray(frame, min(PROC_WIDTH, frame.shape[1]))
            if not cam.prepare(g.shape[1], g.shape[0]):
                continue
            grays[idx] = g
            if cam.ref is None:
                cam.ref = cam.prev = cam.empty = g
        if not grays or not self.detecting:
            for idx, g in grays.items():
                self.cams[idx].prev = g
            return events

        if self._lighting(grays):
            # light switched on/off or the cameras are still adjusting their exposure: no hand, no dart –
            # just follow the image. The calibration is not affected, the board did not move.
            for idx, g in grays.items():
                cam = self.cams[idx]
                cam.ref = cam.prev = g
            self.moving = False
            self.calm = 0
            if self.state == "takeout_in_progress" and self._pre_takeout:
                self.state, self.darts = self._pre_takeout
                self._pre_takeout = None
                events.append(("state",))
            return events

        thr = s.diffThreshold
        motion_px = max(15, s.minDartArea // 2)
        moving_now = False
        for idx, g in grays.items():
            cam = self.cams[idx]
            m = cv2.countNonZero(cv2.bitwise_and((cv2.absdiff(g, cam.prev) > thr).astype(np.uint8) * 255, cam.roi))
            cam.prev = g
            if m > motion_px:
                moving_now = True

        if moving_now:
            self.moving = True
            self.calm = 0
            # a hand in front of the board -> takeout started (no need to wait for calm)
            if self.state != "takeout_in_progress":
                areas = {i: self._change_area(i, g, self.cams[i].ref) for i, g in grays.items()}
                if self._is_hand(areas):
                    self._enter_takeout(events)
            return events

        if not self.moving:
            return events
        self.calm += 1
        needed = s.settleFrames * (2 if self.state == "takeout_in_progress" else 1)
        if self.calm < needed:
            return events
        self.moving = False
        self.calm = 0
        self._evaluate(grays, events)
        return events

    def _lighting(self, grays: dict[int, np.ndarray]) -> bool:
        """True while the light changes (switched on/off, auto exposure settling) or it is too dark to see darts."""
        now = time.monotonic()
        # brightness of a 3x3 grid per camera
        means = {idx: cv2.resize(g, (3, 3), interpolation=cv2.INTER_AREA).astype(np.float32).ravel() for idx, g in grays.items()}

        def light_jump(idx: int, cur: np.ndarray) -> bool:
            prev = self._means.get(idx)
            if prev is None:
                return False
            rel = (cur - prev) / np.maximum(prev, 8.0)
            # a hand covers a part of the image – a light switch changes (almost) the whole image the same way
            return int(np.sum(rel > 0.15)) >= 7 or int(np.sum(rel < -0.15)) >= 7

        jumps = [light_jump(i, m) for i, m in means.items()]
        known = all(i in self._means for i in means)
        self._means = means
        if known and jumps and all(jumps):
            if now >= self._light_until:
                log.info("Lichtwechsel erkannt – Erkennung pausiert kurz")
            self._light_until = now + 3.0
        dark = all(float(m.max()) < 18 for m in means.values())
        if dark != self.dark:
            self.dark = dark
            log.info("Board ist zu dunkel – Erkennung wartet auf Licht" if dark else "Licht ist wieder da")
        return dark or now < self._light_until

    # ------------------------------------------------------------------ evaluation
    def _diff_mask(self, idx: int, g: np.ndarray, ref: np.ndarray) -> np.ndarray:
        cam = self.cams[idx]
        mask = (cv2.absdiff(g, ref) > self.settings.diffThreshold).astype(np.uint8) * 255
        mask = cv2.bitwise_and(mask, cam.roi)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
        return mask

    def _change_area(self, idx: int, g: np.ndarray, ref: np.ndarray | None) -> int:
        if ref is None:
            return 0
        return cv2.countNonZero(self._diff_mask(idx, g, ref))

    def _is_hand(self, areas: dict[int, int]) -> bool:
        big = [a for a in areas.values() if a > self.settings.takeoutArea]
        return len(big) >= 2 or any(a > 2 * self.settings.takeoutArea for a in areas.values()) or (
            len(areas) == 1 and len(big) == 1
        )

    def _enter_takeout(self, events: list[tuple]) -> None:
        if self.state == "takeout_in_progress":
            return
        self._pre_takeout = (self.state, self.darts)
        self.state = "takeout_in_progress"
        events.append(("takeout_started",))
        events.append(("state",))

    def _set_refs(self, grays: dict[int, np.ndarray], empty: bool = False) -> None:
        for idx, g in grays.items():
            self.cams[idx].ref = g
            if empty:
                self.cams[idx].empty = g

    def _evaluate(self, grays: dict[int, np.ndarray], events: list[tuple]) -> None:
        s = self.settings
        masks = {i: self._diff_mask(i, g, self.cams[i].ref) for i, g in grays.items()}
        areas = {i: cv2.countNonZero(m) for i, m in masks.items()}
        self.last_areas = areas

        if self._is_hand(areas):
            self._enter_takeout(events)
            return

        if self.state == "takeout_in_progress":
            # areas = change against the board before the hand appeared
            if max(areas.values()) < s.minDartArea * 0.75 and self._pre_takeout:
                # the hand went away without changing anything
                self.state, self.darts = self._pre_takeout
                self._pre_takeout = None
                events.append(("state",))
                return
            # darts were pulled (all of them, or the board is at least different now). If the
            # player comes back for the remaining darts, that is simply another takeout.
            self.darts = 0
            self.state = "throw"
            self._pre_takeout = None
            self._set_refs(grays, empty=True)
            events.append(("takeout_finished",))
            events.append(("state",))
            return

        if max(areas.values()) < s.minDartArea:
            self._set_refs(grays)  # noise / slow light change
            return

        if self.state == "takeout":
            self._set_refs(grays)  # more than three darts: ignore
            return

        observations = []
        for idx, mask in masks.items():
            if areas[idx] < s.minDartArea:
                continue
            obs = self._analyze(idx, mask)
            if obs is not None:
                observations.append(obs)
        result = fuse(observations)
        self._set_refs(grays)
        if result is None:
            log.info("change detected but no dart found (areas %s)", areas)
            return
        x, y, cams, confidence = result
        number, multiplier = score(x, y)
        tips = {}
        for idx in cams:
            cam = self.cams[idx]
            p = apply_h(cam.H, [[x, y]])[0]
            tips[idx] = {"x": float(p[0] / cam.size[0]), "y": float(p[1] / cam.size[1])}
        self.darts += 1
        if self.darts >= 3:
            self.state = "takeout"
            events.append(("state",))
        events.append(
            (
                "dart",
                {
                    "id": uuid.uuid4().hex,
                    "x": round(float(x), 2),
                    "y": round(float(y), 2),
                    "seg": {"number": number, "multiplier": multiplier},
                    "confidence": round(float(confidence), 2),
                    "cameras": sorted(cams),
                    "tips": {str(k): v for k, v in tips.items()},
                },
            )
        )
        events.append(("state",))

    def _analyze(self, idx: int, mask: np.ndarray) -> Observation | None:
        cam = self.cams[idx]
        # The dart often falls apart into pieces (dark shaft on a dark board gives no difference):
        # start with the biggest blob and grow it by nearby fragments.
        n, labels, stats, centroids = cv2.connectedComponentsWithStats(mask, connectivity=8)
        comps = [i for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] >= 6]
        if not comps:
            return None
        # single-linkage clustering of fragments: close fragments, or fragments lined up along
        # the board normal (point, barrel and flight of one dart can be far apart near the camera)
        reach = max(30.0, 0.07 * mask.shape[1])
        along_reach = 0.45 * mask.shape[0]
        parent = {i: i for i in comps}

        def find(i: int) -> int:
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        boxes = {i: stats[i, :4] for i in comps}
        for a_i, a in enumerate(comps):
            ax, ay, aw, ah = boxes[a]
            for b in comps[a_i + 1 :]:
                bx, by, bw, bh = boxes[b]
                gap_x = max(0, max(ax, bx) - min(ax + aw, bx + bw))
                gap_y = max(0, max(ay, by) - min(ay + ah, by + bh))
                join = math.hypot(gap_x, gap_y) <= reach
                if not join:
                    delta = centroids[b] - centroids[a]
                    dn = cam.normal_direction((centroids[a] + centroids[b]) / 2)
                    if dn is not None:
                        along = abs(float(delta @ dn))
                        across = abs(float(delta[0] * dn[1] - delta[1] * dn[0]))
                        join = along <= along_reach and across <= 12 + 0.3 * along
                if join:
                    parent[find(a)] = find(b)
        clusters: dict[int, list[int]] = {}
        for i in comps:
            clusters.setdefault(find(i), []).append(i)
        members = max(clusters.values(), key=lambda m: sum(int(stats[i, cv2.CC_STAT_AREA]) for i in m))
        blob = np.isin(labels, members)
        ys, xs = np.nonzero(blob)
        if len(xs) < max(8, self.settings.minDartArea // 3):
            return None
        pts = np.column_stack([xs, ys]).astype(np.float64)
        mean = pts.mean(axis=0)
        cov = np.cov((pts - mean).T)
        evals, evecs = np.linalg.eigh(cov)
        v = evecs[:, 1]
        t = (pts - mean) @ v
        length = float(t.max() - t.min())
        if length < 10:
            return None

        # 1) initial axis, oriented from the tip towards the flight
        dn = cam.normal_direction(mean)
        if dn is not None:
            away = dn  # darts stand roughly perpendicular on the board
        else:
            perp = (pts - mean) @ np.array([-v[1], v[0]])
            band = 0.18 * length
            w_min = float(perp[t < t.min() + band].std())
            w_max = float(perp[t > t.max() - band].std())
            away = v if w_min <= w_max else -v  # the flight end is the wide one

        # 2) remove the (wide) flight, keep point + barrel (+ shaft) for the axis fit
        thin, flight = _split_flight(pts, mean, away)
        if len(thin) >= 10:
            vx, vy, x0, y0 = cv2.fitLine(thin.astype(np.float32), cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
            d = np.array([vx, vy], dtype=np.float64)
            p0 = np.array([x0, y0], dtype=np.float64)
            if d @ away < 0:
                d = -d
            proj = (thin - p0) @ d
            extent = float(proj.max() - proj.min())
            near = thin[proj < proj.min() + 1.5]
            tip_img = p0 + d * float(((near - p0) @ d).mean())
            # thin part: reliable direction; if the flight is visible too, the axis must pass through it
            weight = min(1.0, extent / 35.0)
            if len(flight) >= 10:
                fc = flight.mean(axis=0)
                off = abs(float((fc - p0) @ np.array([-d[1], d[0]])))
                if off > 6:
                    weight *= 0.5
        else:
            # only the flight is visible: assume the dart is perpendicular to the board
            if dn is None:
                return None
            d = dn
            proj = (pts - mean) @ d
            tip_img = mean + d * float(proj.min())
            extent = length
            weight = 0.08
        far_img = tip_img + d * max(25.0, extent)
        tip_b, far_b = apply_h(cam.Hinv, [tip_img, far_img])
        u = far_b - tip_b
        norm = float(np.linalg.norm(u))
        if norm < 1e-6:
            return None
        u /= norm
        normal = np.array([-u[1], u[0]])
        return Observation(idx, tip_b, normal, float(normal @ tip_b), length, len(xs), max(weight, 0.05))


def _split_flight(pts: np.ndarray, mean: np.ndarray, away: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Split blob points into the thin part (point/barrel/shaft) and the wide flight."""
    perp_dir = np.array([-away[1], away[0]])
    t = (pts - mean) @ away
    s = (pts - mean) @ perp_dir
    t0 = t.min()
    bins = ((t - t0) // 3).astype(int)
    nb = int(bins.max()) + 1
    lo = np.full(nb, np.inf)
    hi = np.full(nb, -np.inf)
    np.minimum.at(lo, bins, s)
    np.maximum.at(hi, bins, s)
    filled = np.isfinite(lo)
    width = np.where(filled, hi - lo + 1, 0)
    ref = np.percentile(width[filled], 30) if np.any(filled) else 1
    wide = width > max(7.0, 2.5 * ref)
    if not np.any(wide):
        return pts, pts[:0]
    first_wide = int(np.argmax(wide))
    # everything from the first wide bin onwards (towards the flight end) is flight
    thin_mask = bins < first_wide
    return pts[thin_mask], pts[~thin_mask]


def _intersect(a: Observation, b: Observation) -> np.ndarray | None:
    A = np.array([a.normal, b.normal])
    if abs(float(np.linalg.det(A))) < 0.08:  # lines (almost) parallel
        return None
    return np.linalg.solve(A, np.array([a.offset, b.offset]))


def fuse(obs: list[Observation]) -> tuple[float, float, list[int], float] | None:
    """Robustly intersect the board lines of all cameras (pairwise consensus + least squares)."""
    if not obs:
        return None
    if len(obs) == 1:
        o = obs[0]
        return float(o.tip_board[0]), float(o.tip_board[1]), [o.camera], 0.3

    best = None
    for i, a in enumerate(obs):
        for b in obs[i + 1 :]:
            X = _intersect(a, b)
            if X is None or math.hypot(*X) > BOARD_RADIUS + 40:
                continue
            inliers = [o for o in obs if abs(float(o.normal @ X - o.offset)) < 5.0]
            score_ = (sum(o.weight for o in inliers), a.weight + b.weight)
            if best is None or score_ > best[0]:
                best = (score_, X, inliers)
    if best is None:
        inliers = list(obs)  # all pairs degenerate: lines + tip prior
    else:
        inliers = best[2]
    X = _solve(inliers)
    res = [abs(float(o.normal @ X - o.offset)) for o in inliers] or [5.0]
    support = sum(o.weight for o in inliers) / max(1e-6, sum(o.weight for o in obs))
    confidence = max(0.2, min(1.0, (1.0 - float(np.mean(res)) / 8.0) * (0.6 + 0.4 * support) * (0.8 + 0.1 * len(inliers))))
    if best is None:
        confidence = min(confidence, 0.4)
    return float(X[0]), float(X[1]), [o.camera for o in inliers], confidence


TIP_PRIOR = 0.004


def _solve(items: list[Observation]) -> np.ndarray:
    """Weighted least squares on the board lines plus a weak prior towards the visible tips.

    The prior only matters in directions the lines do not constrain (nearly parallel lines).
    """
    rows, rhs = [], []
    for o in items:
        w = math.sqrt(o.weight)
        rows.append(o.normal * w)
        rhs.append(o.offset * w)
    k = math.sqrt(TIP_PRIOR)
    for o in items:
        rows += [np.array([k, 0.0]), np.array([0.0, k])]
        rhs += [k * o.tip_board[0], k * o.tip_board[1]]
    X, *_ = np.linalg.lstsq(np.array(rows), np.array(rhs), rcond=None)
    return X
