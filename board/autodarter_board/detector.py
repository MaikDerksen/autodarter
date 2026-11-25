"""Dart detection from 1..n calibrated cameras.

Motion / calm detection runs on every frame on grey images scaled down to PROC_WIDTH (cheap).
Pipeline per evaluation (once per dart, after the image has calmed down):
  1. difference image against the reference (board before the throw), small images
  2. the new dart is the largest changed blob inside the board region
  3. the axis is fitted on the full resolution frames around that blob (the reference is kept in
     full resolution too): tip-side part of the blob (flight removed), centres of its 1 px cross
     sections, cross sections next to older darts (partly hidden) are skipped
  4. via the calibration homography the image axis is mapped onto the board plane:
     the dart tip is guaranteed to lie on this board line (it is the intersection of the
     dart with the board plane), even if the thin steel tip itself is not visible
  5. the board lines of all cameras are intersected (pairwise consensus + least squares) -> tip position
"""
from __future__ import annotations

import logging
import math
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass

import cv2
import numpy as np

from .config import Settings
from .geometry import BOARD_RADIUS, apply_h, board_to_image_homography, calibration_mirrored, circle_points, estimate_pose, project3d, score

log = logging.getLogger(__name__)

PROC_WIDTH = 640  # motion / calm detection and the decisions (areas) run on this image width
# Normalised calibration points are image positions in edge coordinates (as the app places them on the
# picture: 0 = left edge of the first pixel, 1 = right edge of the last one). OpenCV pixel centres are
# integers, so a normalised x maps to x * width - 0.5.
CALIB_ORIGIN = 0.5
FULL_BLUR = 3  # Gaussian kernel for the full resolution dart analysis

# Official rule: a dart that bounces out or falls out of the board before it is retrieved does not score.
BOUNCE_MAX_S = 1.5  # a bounce-out is a short motion (dart hits and drops) ...
BOUNCE_AREA = 2.0  # ... seen by (at least two) cameras with >= BOUNCE_AREA * minDartArea moving pixels ...
BOUNCE_ELONGATION = 2.0  # ... where they saw a dart shaped object (not a shadow) in front of the board ...
QUIET_AFTER_HAND_S = 5.0  # ... and not right after a hand was at the board (walking back after the takeout)
LOW_THRESHOLD = 0.5  # hysteresis: weaker changes (x diffThreshold) count when connected to clear ones
SHADOW_EDGE = 10  # px around a shadow (processing image) where no weak dart pixels are added
LIGHT_MIN_PX = 30  # a change region needs this many pixels for the shadow / light test
LIGHT_WINDOW = 7  # local brightness ratio window (processing image pixels)
LIGHT_EDGE = 60.0  # Sobel magnitude of a board edge (wire, sector border) in the processing image
LIGHT_EDGE_SHARE = 0.04  # ... at least this share of the region must lie on board edges ...
LIGHT_EDGE_CORR = 0.9  # ... which keep their direction (gradient correlation current vs. reference)
GONE_SHARE = 0.75  # a dart fell out when (nearly) all its pixels show the empty board again
AGREEMENT_WINDOW = 12  # darts seen by >= 3 cameras: does a camera agree with the others?
# Something that lies flat on the board (a thin shadow or light streak, e.g. somebody walking past a lamp)
# is at the same board position for every camera. A dart sticks out of the board: mapped onto the board
# plane, each camera sees it somewhere else - only around the tip do the cameras agree.
FLAT_CELL = 2.0  # mm, board plane grid for that comparison ...
FLAT_RADIUS = 240.0  # ... on the board and the surround ring around it ...
FLAT_TOL = 6.0  # ... calibration differences between the cameras ...
FLAT_COVER = 0.7  # ... a change is flat when another camera saw this share of it at the same board place ...
FLAT_EXTENT = 25.0  # ... and the common part is long (a dart's is just its tip: <= 15 mm in the simulator) ...
FLAT_COVER_LONG = 0.5  # ... or this share along a really long stretch (a dart: <= 20 mm with >= 50 %)
FLAT_EXTENT_LONG = 45.0
STREAK_GAP = 10.0  # mm: a short piece is part of a streak when another camera sees its line go on on both
STREAK_REACH = 50.0  # sides (from STREAK_GAP to STREAK_REACH beyond its ends) - a dart's line ends at its tip
STREAK_COVER = 0.7
LONELY_REACH = 150.0  # a dart only one camera sees: is it the end of a streak another camera sees along its line?
LONELY_COVER = 0.5
LONELY_TURN = 12.0  # deg: the direction of a short piece is uncertain - try the line turned by up to this much
TIP_WINDOW = 25  # px (processing image): a dart seen by one camera only must change something there in another one
EVIDENCE_KEEP = 9  # bug reports: camera images of the last darts / bounce-outs (three turns) ...
DISCARDED_KEEP = 6  # ... and of the last changes that were no dart (a missed dart ends up there)


@dataclass
class Observation:
    camera: int
    tip_board: np.ndarray  # visible tip end mapped to the board (biased if the tip is hidden)
    normal: np.ndarray  # unit normal of the board line through the tip
    offset: float  # line: normal . X = offset
    length_px: float
    area: int
    weight: float


_FLAT_N = int(2 * FLAT_RADIUS / FLAT_CELL) + 1
_FLAT_KERNEL = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * int(FLAT_TOL / FLAT_CELL) + 1,) * 2)


def _footprint(cam: "CameraState", mask: np.ndarray) -> np.ndarray | None:
    """Changed pixels of a camera mapped onto the board plane (grid of FLAT_CELL mm, on the board only).

    Right for everything that lies on the board; for a dart (which sticks out) only its tip is right.
    """
    if cam.Hinv is None or mask is None:
        return None
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return None
    if len(xs) > 8000:
        step = len(xs) // 8000 + 1
        xs, ys = xs[::step], ys[::step]
    P = cam.Hinv @ np.vstack([xs, ys, np.ones(len(xs))])
    ok = P[2] > 1e-9  # beyond the horizon of the board plane
    bx, by = P[0, ok] / P[2, ok], P[1, ok] / P[2, ok]
    on = bx * bx + by * by <= FLAT_RADIUS * FLAT_RADIUS
    if not on.any():
        return None
    grid = np.zeros((_FLAT_N, _FLAT_N), np.uint8)
    gx = np.clip(((bx[on] + FLAT_RADIUS) / FLAT_CELL).astype(np.int32), 0, _FLAT_N - 1)
    gy = np.clip(((by[on] + FLAT_RADIUS) / FLAT_CELL).astype(np.int32), 0, _FLAT_N - 1)
    grid[gy, gx] = 1
    return grid


def _flat(mine: np.ndarray | None, other: np.ndarray | None) -> bool:
    """Did the other camera see (nearly) all of this change at the same place on the board, along a long
    stretch? Then it lies on the board - a dart would be somewhere else for the other camera."""
    if mine is None or other is None:
        return False
    total = int(mine.sum())
    if total == 0:
        return False
    common = mine & cv2.dilate(other, _FLAT_KERNEL)
    share = int(common.sum()) / total
    if share < FLAT_COVER_LONG:
        return False
    ys, xs = np.nonzero(common)
    length = math.hypot(float(np.ptp(xs)), float(np.ptp(ys))) * FLAT_CELL
    return length >= (FLAT_EXTENT if share >= FLAT_COVER else FLAT_EXTENT_LONG)


def _continues(
    o: "Observation",
    mine: np.ndarray | None,
    other: np.ndarray | None,
    reach: float = STREAK_REACH,
    both: bool = True,
    cover: float = STREAK_COVER,
    turn: float = 0.0,
) -> bool:
    """Does the other camera see this camera's line go on beyond both ends of what this camera saw (both=False:
    beyond one end)? Then it is a piece of a streak lying on the board. A dart's line ends at its tip on one
    side and at the flight on the other one (another camera sees the dart in its own direction, not along
    this line)."""
    if mine is None or other is None:
        return False
    ys, xs = np.nonzero(mine)
    if len(xs) == 0:
        return False
    cells = np.column_stack([xs, ys]) * FLAT_CELL - FLAT_RADIUS + FLAT_CELL / 2
    centre = cells.mean(axis=0)
    near = cv2.dilate(other, _FLAT_KERNEL)
    base = math.atan2(o.normal[0], -o.normal[1])
    for a in np.radians(np.arange(-turn, turn + 0.1, 3.0)) if turn else [0.0]:
        u = np.array([math.cos(base + a), math.sin(base + a)])
        t = (cells - centre) @ u
        sides = []
        for side in (np.arange(t.min() - STREAK_GAP, t.min() - reach, -FLAT_CELL), np.arange(t.max() + STREAK_GAP, t.max() + reach, FLAT_CELL)):
            pts = centre + side[:, None] * u
            pts = pts[(pts**2).sum(axis=1) <= (FLAT_RADIUS - FLAT_CELL) ** 2]
            if len(pts) < 8:
                sides.append(False)  # nobody can tell
                continue
            g = ((pts + FLAT_RADIUS) / FLAT_CELL).astype(np.int32)
            sides.append(float(near[g[:, 1], g[:, 0]].mean()) >= cover)
        if all(sides) if both else any(sides):
            return True
    return False


def _obs_info(obs: list[Observation]) -> list[dict]:
    """What every camera saw (for bug reports): tip on the board (mm), line, size."""
    return [
        {
            "camera": o.camera,
            "tip": [round(float(o.tip_board[0]), 1), round(float(o.tip_board[1]), 1)],
            "normal": [round(float(o.normal[0]), 4), round(float(o.normal[1]), 4)],
            "offset": round(float(o.offset), 2),
            "lengthPx": round(float(o.length_px), 1),
            "area": int(o.area),
            "weight": round(float(o.weight), 3),
        }
        for o in obs
    ]


def _homography(points: list[tuple[float, float]], w: int, h: int) -> np.ndarray | None:
    """Board mm -> OpenCV pixel coordinates of a w x h image."""
    H = board_to_image_homography(points, w, h)
    if H is None:
        return None
    return np.array([[1.0, 0, -CALIB_ORIGIN], [0, 1.0, -CALIB_ORIGIN], [0, 0, 1.0]]) @ H


def _pose(H: np.ndarray, w: int, h: int):
    try:
        return estimate_pose(H, w, h)
    except Exception:  # degenerate calibration
        return None


class CameraState:
    def __init__(self, index: int, points: list[tuple[float, float]]):
        self.index = index
        self.points = points
        # points in mirrored order (two of them swapped): every board position of this camera would be
        # mirrored -> it still helps to see motion / hands, but its darts are not used
        self.mirrored = calibration_mirrored(points)
        self.size: tuple[int, int] | None = None
        self.H: np.ndarray | None = None  # board -> proc image
        self.Hinv: np.ndarray | None = None
        self.pose: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None
        # the same for the full resolution frames (dart analysis)
        self.full_size: tuple[int, int] | None = None
        self.Hf: np.ndarray | None = None
        self.Hfinv: np.ndarray | None = None
        self.posef: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None
        self.roi: np.ndarray | None = None
        self.ref: np.ndarray | None = None
        self.ref_full: np.ndarray | None = None  # full resolution grey image of the reference
        self.prev: np.ndarray | None = None
        self.empty: np.ndarray | None = None
        self.empty_full: np.ndarray | None = None  # full resolution board without darts (after a takeout)

    def normal_direction(self, img_pt: np.ndarray, full: bool = False) -> np.ndarray | None:
        """Image direction in which a dart standing at img_pt points away from the board."""
        pose, Hinv = (self.posef, self.Hfinv) if full else (self.pose, self.Hinv)
        if pose is None:
            return None
        b = apply_h(Hinv, [img_pt])[0]
        K, R, t = pose
        p = project3d(K, R, t, [[b[0], b[1], 0.0], [b[0], b[1], 40.0]])
        d = p[1] - p[0]
        n = float(np.linalg.norm(d))
        return d / n if n > 1e-6 else None

    def prepare(self, w: int, h: int, fw: int | None = None, fh: int | None = None) -> bool:
        fw, fh = fw or w, fh or h
        if self.size == (w, h) and self.full_size == (fw, fh) and self.H is not None:
            return True
        H = _homography(self.points, w, h)
        Hf = _homography(self.points, fw, fh)
        if H is None or Hf is None:
            return False
        self.size, self.full_size = (w, h), (fw, fh)
        self.H, self.Hf = H, Hf
        self.Hinv, self.Hfinv = np.linalg.inv(H), np.linalg.inv(Hf)
        self.pose, self.posef = _pose(H, w, h), _pose(Hf, fw, fh)
        outline = apply_h(H, circle_points(BOARD_RADIUS * 1.04, 96)).astype(np.int32)
        roi = np.zeros((h, w), np.uint8)
        cv2.fillPoly(roi, [outline], 255)
        # darts stick out of the board towards the camera -> grow the region generously
        k = max(15, int(h * 0.22)) | 1
        self.roi = cv2.dilate(roi, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
        self.ref = self.prev = self.empty = self.ref_full = self.empty_full = None
        return True

    @property
    def scaled(self) -> bool:
        """The full resolution frames are bigger than the processing images."""
        return self.full_size is not None and self.full_size != self.size


def _gray(frame: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame


def _shrink(gray: np.ndarray, width: int) -> np.ndarray:
    h, w = gray.shape[:2]
    if w != width:
        gray = cv2.resize(gray, (width, int(round(h * width / w))), interpolation=cv2.INTER_AREA)
    return cv2.GaussianBlur(gray, (5, 5), 0)


def _light_only(cur: np.ndarray, ref: np.ndarray, sel: np.ndarray, strict: bool = True) -> bool:
    """True if the changed pixels ``sel`` only got darker (or brighter): the board seen through a
    shadow (player in front of the light, arm while aiming) or in more light.

    The board's own pattern (wires, sector edges, numbers) stays visible, scaled by a smooth
    factor. A dart covers it: in front of the board edges disappear and its own edges appear. A
    region without any board pattern cannot be told apart from a plain dart part (a black barrel
    on a cream sector, a flight on a black one) - it counts as possibly a dart, unless ``strict``
    is off (bounce-outs: there a missed dart costs nothing, a shadow taken for a dart a whole turn).
    """
    n = int(np.count_nonzero(sel))
    if n < LIGHT_MIN_PX:
        return False
    c = cur.astype(np.float32) + 1.0
    r = ref.astype(np.float32) + 1.0
    cs, rs = c[sel], r[sel]
    darker = float(np.mean(cs < rs))
    if 0.05 < darker < 0.95:
        return False
    # the board pattern inside the region must still be there, with the same edge directions
    gcx, gcy = cv2.Sobel(c, cv2.CV_32F, 1, 0), cv2.Sobel(c, cv2.CV_32F, 0, 1)
    grx, gry = cv2.Sobel(r, cv2.CV_32F, 1, 0), cv2.Sobel(r, cv2.CV_32F, 0, 1)
    edges = sel & (cv2.magnitude(grx, gry) >= LIGHT_EDGE)
    corr = None
    if int(np.count_nonzero(edges)) >= max(8, LIGHT_EDGE_SHARE * n):
        cx, cy, rx, ry = gcx[edges], gcy[edges], grx[edges], gry[edges]
        corr = float(np.sum(cx * rx + cy * ry)) / math.sqrt(float(np.sum(cx * cx + cy * cy) * np.sum(rx * rx + ry * ry)) + 1e-6)
        if corr < LIGHT_EDGE_CORR:
            return False
    elif strict:
        return False
    # and the brightness follows the board, scaled by a smooth (local) factor
    k = cv2.blur(c, (LIGHT_WINDOW, LIGHT_WINDOW)) / cv2.blur(r, (LIGHT_WINDOW, LIGHT_WINDOW))
    dev = float(np.median(np.abs(cs - k[sel] * rs)))
    limit = max(4.0, 0.06 * float(np.median(np.abs(cs - rs))))
    if not strict and corr is not None and corr >= 0.97:
        # board pattern clearly kept; thin pieces (a ring under the shadow) get neighbouring colours
        # into the ratio window
        limit *= 2
    return dev <= limit


def _without_light(cur: np.ndarray, ref: np.ndarray, mask: np.ndarray, strict: bool = True) -> np.ndarray:
    """The change mask without the regions that are only shadows / light changes."""
    if cv2.countNonZero(mask) < LIGHT_MIN_PX:
        return mask
    ys, xs = np.nonzero(mask)
    pad = LIGHT_WINDOW
    y0, y1 = max(0, int(ys.min()) - pad), min(mask.shape[0], int(ys.max()) + 1 + pad)
    x0, x1 = max(0, int(xs.min()) - pad), min(mask.shape[1], int(xs.max()) + 1 + pad)
    m, c, r = mask[y0:y1, x0:x1], cur[y0:y1, x0:x1], ref[y0:y1, x0:x1]
    if _light_only(c, r, m > 0, strict):  # all of it (a shadow falls apart into many small pieces)
        return np.zeros_like(mask)
    out = None
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    for i in range(1, n):
        x, y, w, h, area = (int(v) for v in stats[i])
        if area < LIGHT_MIN_PX:
            continue
        bx0, by0 = max(0, x - pad), max(0, y - pad)
        bx1, by1 = min(m.shape[1], x + w + pad), min(m.shape[0], y + h + pad)
        sel = labels[by0:by1, bx0:bx1] == i
        if _light_only(c[by0:by1, bx0:bx1], r[by0:by1, bx0:bx1], sel, strict):
            if out is None:
                out = mask.copy()
            out[y0 + by0 : y0 + by1, x0 + bx0 : x0 + bx1][sel] = 0
    return mask if out is None else out


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
        # darts of the current turn: id + per camera the pixels where it covers the empty board (fall-out check)
        self.turn_darts: list[dict] = []
        self._blobs: dict[int, np.ndarray] = {}
        self._prints: dict[int, np.ndarray | None] = {}  # board plane footprints of all changes per camera (flat test)
        # the motion before the current evaluation (bounce-out check)
        self._motion_start = 0.0
        self._motion_last = 0.0
        self._motion_peak: dict[int, int] = {}
        self._motion_hand = False
        self._motion_darts: set[int] = set()  # cameras that saw a dart shaped object during the motion
        self._motion_flat = False  # ... or something flat on the board (shadow / light streak): no bounce-out
        self._quiet_until = 0.0
        # per camera: was its line part of the consensus of darts that >= 3 cameras saw
        self.agreement: dict[int, deque] = {}
        # lighting: mean brightness per camera, "settling" until, and whether the board is too dark
        self._means: dict[int, np.ndarray] = {}
        self._light_until = 0.0
        self.dark = False
        self.last_lighting = 0.0  # wall clock of the last frame treated as a light change
        # bug reports: the full resolution grey images of the last detections (references only, no copies)
        self.evidence: deque = deque(maxlen=EVIDENCE_KEEP)
        self.discarded: deque = deque(maxlen=DISCARDED_KEEP)
        self._motion_frames: dict[int, np.ndarray] = {}  # per camera: frame at the peak of the current motion

    # ------------------------------------------------------------------ control
    def set_calibration(self, index: int, points: list[tuple[float, float]] | None) -> None:
        with self._lock:
            if points is None:
                self.cams.pop(index, None)
            else:
                cam = CameraState(index, [tuple(p) for p in points])
                self.agreement.pop(index, None)
                if cam.mirrored:
                    log.warning(
                        "Kalibrierung von Kamera %d ist spiegelverkehrt (Punkte vertauscht) – ihre Darts werden ignoriert, bitte neu kalibrieren",
                        index + 1,
                    )
                self.cams[index] = cam

    def reset(self) -> None:
        with self._lock:
            for c in self.cams.values():
                c.ref = c.prev = c.empty = c.ref_full = c.empty_full = None
            self.darts = 0
            self.state = "throw"
            self.moving = False
            self.calm = 0
            self._pre_takeout = None
            self.turn_darts = []
            self._motion_peak = {}
            self._motion_hand = False
            self._motion_darts = set()
            self._motion_flat = False

    def set_detecting(self, on: bool) -> None:
        with self._lock:
            self.detecting = on
            if on:
                self.reset()

    @property
    def calibrated(self) -> bool:
        return bool(self.cams)

    def camera_issue(self, index: int) -> str | None:
        """'mirrored': calibration points swapped; 'inconsistent': its darts often disagree with the other cameras."""
        cam = self.cams.get(index)
        if cam is None:
            return None
        if cam.mirrored:
            return "mirrored"
        hist = self.agreement.get(index)
        if hist is not None and len(hist) >= 8 and sum(hist) / len(hist) < 0.4:
            return "inconsistent"
        return None

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
        fulls: dict[int, np.ndarray] = {}  # full resolution grey frames, only used for the dart analysis
        for idx, cam in self.cams.items():
            frame = frames.get(idx)
            if frame is None:
                continue
            full = _gray(frame)
            g = _shrink(full, min(PROC_WIDTH, full.shape[1]))
            if not cam.prepare(g.shape[1], g.shape[0], full.shape[1], full.shape[0]):
                continue
            grays[idx] = g
            fulls[idx] = full
            if cam.ref is None:
                cam.ref = cam.prev = cam.empty = g
                cam.ref_full = cam.empty_full = full
        if not grays or not self.detecting:
            for idx, g in grays.items():
                self.cams[idx].prev = g
            return events

        if self._lighting(grays):
            # light switched on/off or the cameras are still adjusting their exposure: no hand, no dart –
            # just follow the image. The calibration is not affected, the board did not move.
            self.last_lighting = time.time()
            for idx, g in grays.items():
                cam = self.cams[idx]
                cam.ref = cam.prev = g
                cam.ref_full = fulls[idx]
                if self.darts == 0 and self.state == "throw":  # no darts in the board: new empty image
                    cam.empty, cam.empty_full = g, fulls[idx]
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
        frame_diff: dict[int, int] = {}
        for idx, g in grays.items():
            cam = self.cams[idx]
            m = cv2.countNonZero(cv2.bitwise_and((cv2.absdiff(g, cam.prev) > thr).astype(np.uint8) * 255, cam.roi))
            cam.prev = g
            frame_diff[idx] = m
            if m > motion_px:
                moving_now = True

        if moving_now:
            now = time.monotonic()
            if not self.moving:
                self._motion_start, self._motion_peak, self._motion_hand, self._motion_darts = now, {}, False, set()
                self._motion_frames = {}
                self._motion_flat = False
            self._motion_last = now
            for idx, m in frame_diff.items():
                if m > self._motion_peak.get(idx, -1):
                    self._motion_frames[idx] = fulls[idx]
                self._motion_peak[idx] = max(self._motion_peak.get(idx, 0), m)
            self.moving = True
            self.calm = 0
            # a hand in front of the board -> takeout started (no need to wait for calm)
            if self.state != "takeout_in_progress":
                masks = {i: self._diff_mask(i, g, self.cams[i].ref) for i, g in grays.items() if self.cams[i].ref is not None}
                areas = {i: cv2.countNonZero(m) for i, m in masks.items()}
                if self._is_hand(areas):
                    # the player's shadow on the board is no hand
                    masks = {i: _without_light(grays[i], self.cams[i].ref, m) for i, m in masks.items()}
                    areas = {i: cv2.countNonZero(m) for i, m in masks.items()}
                if self._is_hand(areas):
                    self._motion_hand = True
                    self._enter_takeout(events)
                elif self._watch_bounce() and len(self._motion_darts) < 2:
                    self._motion_darts |= self._dart_views(grays, masks, skip=self._motion_darts)
            else:
                self._motion_hand = True
            return events

        if not self.moving:
            return events
        self.calm += 1
        needed = s.settleFrames * (2 if self.state == "takeout_in_progress" else 1)
        if self.calm < needed:
            return events
        self.moving = False
        self.calm = 0
        self._evaluate(grays, fulls, events)
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
        # opening with a 2x2 square (removes single pixels). MORPH_OPEN with an even kernel would
        # shift the whole mask by one pixel (= ~1.5 mm on the board), mirrored anchors keep it in place.
        k = np.ones((2, 2), np.uint8)
        mask = cv2.dilate(cv2.erode(mask, k, anchor=(0, 0)), k, anchor=(1, 1))
        return mask

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

    def _set_refs(self, grays: dict[int, np.ndarray], fulls: dict[int, np.ndarray], empty: bool = False) -> None:
        for idx, g in grays.items():
            self.cams[idx].ref = g
            self.cams[idx].ref_full = fulls.get(idx)
            if empty:
                self.cams[idx].empty = g
                self.cams[idx].empty_full = fulls.get(idx)

    def _evaluate(self, grays: dict[int, np.ndarray], fulls: dict[int, np.ndarray], events: list[tuple]) -> None:
        s = self.settings
        # shadows of the player (and light changes) are neither a hand nor a dart
        raw = {i: self._diff_mask(i, g, self.cams[i].ref) for i, g in grays.items()}
        masks = {i: _without_light(grays[i], self.cams[i].ref, m) for i, m in raw.items()}
        # where the shadows are (their soft edges must not be added to a dart, see _grow)
        shadows = {i: cv2.bitwise_and(m, cv2.bitwise_not(masks[i])) for i, m in raw.items()}
        areas = {i: cv2.countNonZero(m) for i, m in masks.items()}
        self.last_areas = areas
        raw_areas = {i: cv2.countNonZero(m) for i, m in raw.items()}

        if self._is_hand(areas):
            self._motion_hand = True
            self._enter_takeout(events)
            return

        if self.state == "takeout_in_progress":
            self._quiet_until = time.monotonic() + QUIET_AFTER_HAND_S
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
            self.turn_darts = []
            self._set_refs(grays, fulls, empty=True)
            events.append(("takeout_finished",))
            events.append(("state",))
            return

        # A dart of this turn fell out (also while the next one flew in): its pixels show the empty
        # board again. It does not score, and the hole it leaves must not be taken for a new dart.
        gone = self._gone_darts(grays)
        for d in gone:
            self.turn_darts.remove(d)
            log.info("dart %s fell out of the board", d["id"])
            events.append(("dart_out", d["id"]))
        masks = {i: self._only_new(i, m, grays[i]) for i, m in masks.items()}
        areas = {i: cv2.countNonZero(m) for i, m in masks.items()}

        if max(areas.values()) < s.minDartArea:
            if not gone and max(areas.values()) < s.minDartArea // 2 and self._bounced_out():
                self._add_bounce_out(events, fulls, areas, raw_areas)
            elif max(raw_areas.values()) >= s.minDartArea // 2:
                # something changed, but too little (or only light / shadow): a missed dart ends up here
                small = max(areas.values()) >= s.minDartArea // 4
                self._keep("discarded", fulls, {"reason": "too_small" if small else "shadow", "areas": areas, "rawAreas": raw_areas})
            self._set_refs(grays, fulls)  # noise / slow light change
            return

        if self.state == "takeout":
            self._keep("discarded", fulls, {"reason": "fourth_dart", "areas": areas, "rawAreas": raw_areas})
            self._set_refs(grays, fulls)  # more than three darts: ignore
            return

        observations = []
        self._blobs = {}
        # At least one camera saw a dart. Far from a camera a dart is small in its image (often just
        # below minDartArea), but every additional view makes the intersection much more stable.
        for idx, mask in masks.items():
            if self.cams[idx].mirrored:
                continue
            mask = self._grow(idx, grays[idx], mask, shadows.get(idx))
            if cv2.countNonZero(mask) < max(8, s.minDartArea // 3):
                continue
            obs = self._analyze(idx, mask, fulls.get(idx), grays.get(idx))
            if obs is not None:
                observations.append(obs)
        # a thin shadow / light streak looks like a dart in every single camera - but it lies on the board
        flat = self._flat_observations(observations, grays)
        observations = [o for o in observations if o.camera not in flat]
        result = fuse(observations)
        lonely = None
        if result is not None and len(result[2]) == 1:
            only = result[2][0]
            if self._streak_end(next(o for o in observations if o.camera == only), grays):
                flat.add(only)  # the end of a streak (the others see it go on along this line)
                result = None
            elif not self._seen_elsewhere(only, result[0], result[1], grays, shadows):
                lonely, result = only, None  # one camera only, and the others see nothing where that dart would be
        if result is None:
            reason = "flat" if flat else "single_camera" if lonely is not None else "no_dart_found"
            self._keep(
                "discarded",
                fulls,
                {"reason": reason, "areas": areas, "rawAreas": raw_areas, "observations": _obs_info(observations), "flat": sorted(flat), "lonely": lonely},
            )
            self._set_refs(grays, fulls)
            log.info("change detected but no dart found (%s, areas %s)", reason, areas)
            return
        x, y, cams, confidence = result
        if len(observations) >= 3:
            for o in observations:
                self.agreement.setdefault(o.camera, deque(maxlen=AGREEMENT_WINDOW)).append(o.camera in cams)
        number, multiplier = score(x, y)
        tips = {}
        for idx in cams:
            cam = self.cams[idx]
            p = apply_h(cam.Hf, [[x, y]])[0] + CALIB_ORIGIN
            tips[idx] = {"x": float(p[0] / cam.full_size[0]), "y": float(p[1] / cam.full_size[1])}
        dart_id = uuid.uuid4().hex
        self._remember(dart_id, grays)
        self._keep(
            "dart",
            fulls,
            {
                "x": round(float(x), 2),
                "y": round(float(y), 2),
                "seg": {"number": number, "multiplier": multiplier},
                "confidence": round(float(confidence), 2),
                "cameras": sorted(cams),
                "areas": areas,
                "rawAreas": raw_areas,
                "observations": _obs_info(observations),
            },
            dart_id,
        )
        self._set_refs(grays, fulls)
        self.darts += 1
        if self.darts >= 3:
            self.state = "takeout"
            events.append(("state",))
        events.append(
            (
                "dart",
                {
                    "id": dart_id,
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

    def _grow(self, idx: int, g: np.ndarray, strong: np.ndarray, shadow: np.ndarray | None = None) -> np.ndarray:
        """Hysteresis: weaker changes connected to the clear ones belong to the dart as well.

        A black dart in front of a black sector or a red ring differs only by a few grey levels -
        it falls apart into small pieces or vanishes in all but one camera. The pieces that pass the
        normal threshold show where it is, the weaker pixels around them complete it.
        """
        cam = self.cams[idx]
        n_strong = cv2.countNonZero(strong)
        if n_strong == 0 or cam.ref is None:
            return strong
        lo = self.settings.diffThreshold * LOW_THRESHOLD
        weak = cv2.absdiff(g, cam.ref) > lo
        if cam.empty is not None and cam.empty is not cam.ref and cam.empty.shape == g.shape:
            weak &= cv2.absdiff(g, cam.empty) > lo
        weak = cv2.bitwise_and(weak.astype(np.uint8) * 255, cam.roi)
        if shadow is not None and cv2.countNonZero(shadow):
            # not into a shadow or its soft edge
            near = cv2.dilate(shadow, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * SHADOW_EDGE + 1, 2 * SHADOW_EDGE + 1)))
            weak = cv2.bitwise_and(weak, cv2.bitwise_not(near))
        weak = cv2.bitwise_or(weak, strong)
        n, labels = cv2.connectedComponents(weak, connectivity=8)
        keep = np.unique(labels[strong > 0])
        grown = np.isin(labels, keep[keep > 0])
        if int(np.count_nonzero(grown)) > max(4 * n_strong, n_strong + 1500):
            return strong  # a slow light change around the dart, not the dart
        return grown.astype(np.uint8) * 255

    # ------------------------------------------------------------------ bounce-outs and fall-outs
    def _only_new(self, idx: int, mask: np.ndarray, g: np.ndarray) -> np.ndarray:
        """Changed pixels that are not the empty board (where a dart fell out, the empty board is back)."""
        cam = self.cams[idx]
        if cam.empty is None or cam.empty is cam.ref or cam.empty.shape != g.shape:
            return mask
        new = (cv2.absdiff(g, cam.empty) > self.settings.diffThreshold).astype(np.uint8) * 255
        return cv2.bitwise_and(mask, new)

    def _remember(self, dart_id: str, grays: dict[int, np.ndarray]) -> None:
        """Keep the pixels where the new dart covers the empty board, per camera (for the fall-out check)."""
        stored = {}
        for idx, blob in self._blobs.items():
            cam, g = self.cams.get(idx), grays.get(idx)
            if cam is None or g is None or cam.empty is None or cam.empty.shape != g.shape:
                continue
            sel = blob & (cv2.absdiff(g, cam.empty) > self.settings.diffThreshold)
            ys, xs = np.nonzero(sel)
            if len(xs) < 10:
                continue
            x0, y0 = int(xs.min()), int(ys.min())
            stored[idx] = (sel[y0 : int(ys.max()) + 1, x0 : int(xs.max()) + 1].copy(), x0, y0, cam.empty)
        self.turn_darts.append({"id": dart_id, "masks": stored})

    def _gone_darts(self, grays: dict[int, np.ndarray]) -> list[dict]:
        thr = self.settings.diffThreshold
        gone = []
        for d in self.turn_darts:
            shares = []
            for idx, (m, x0, y0, empty) in d["masks"].items():
                cam, g = self.cams.get(idx), grays.get(idx)
                # the empty board image changed (light switched, recalibrated): no statement possible
                if cam is None or g is None or cam.empty is not empty or empty.shape != g.shape:
                    continue
                h, w = m.shape
                back = cv2.absdiff(g[y0 : y0 + h, x0 : x0 + w], empty[y0 : y0 + h, x0 : x0 + w])[m] <= thr
                if back.size >= 10:
                    shares.append(float(back.mean()))
            # every camera that still sees the spot must see the empty board there (a newer dart in
            # front of it can hide it in one camera)
            if shares and max(shares) >= GONE_SHARE and float(np.median(shares)) >= GONE_SHARE - 0.15:
                gone.append(d)
        return gone

    def _watch_bounce(self) -> bool:
        return bool(getattr(self.settings, "bounceOut", 1)) and self.state == "throw" and self.darts < 3 and not self._motion_hand

    def _weak_mask(self, idx: int, g: np.ndarray) -> np.ndarray | None:
        """Every change of a camera, weak ones included (a streak can be just below the threshold in one
        camera and just above it in another), shadows included, without single pixels."""
        cam = self.cams[idx]
        if cam.ref is None or cam.ref.shape != g.shape:
            return None
        mask = (cv2.absdiff(g, cam.ref) > self.settings.diffThreshold * LOW_THRESHOLD).astype(np.uint8) * 255
        mask = cv2.bitwise_and(mask, cam.roi)
        k = np.ones((2, 2), np.uint8)
        return cv2.dilate(cv2.erode(mask, k, anchor=(0, 0)), k, anchor=(1, 1))

    def _flat_observations(self, observations: list[Observation], grays: dict[int, np.ndarray]) -> set[int]:
        """Cameras whose dart lies flat on the board: another camera saw the same change (weak ones and
        shadows included) at the same board place."""
        others = {i for i, c in self.cams.items() if not c.mirrored and i in grays}
        prints: dict[int, np.ndarray | None] = {}
        self._prints = prints  # for _streak_end
        if len(others) < 2:
            return set()
        flat: set[int] = set()
        for o in observations:
            blob = self._blobs.get(o.camera)
            mine = _footprint(self.cams[o.camera], blob) if blob is not None else None
            for j in sorted(others - {o.camera}):
                if j not in prints:
                    prints[j] = _footprint(self.cams[j], self._weak_mask(j, grays[j]))
                if _flat(mine, prints[j]) or _continues(o, mine, prints[j]):
                    flat.add(o.camera)
                    log.info("camera %d: change lies flat on the board (camera %d sees it at the same place) - no dart", o.camera + 1, j + 1)
                    break
        return flat

    def _streak_end(self, o: Observation, grays: dict[int, np.ndarray]) -> bool:
        """A dart only one camera sees: does another camera see its line go on far beyond one of its ends?"""
        blob = self._blobs.get(o.camera)
        mine = _footprint(self.cams[o.camera], blob) if blob is not None else None
        for j, cam in self.cams.items():
            if j == o.camera or cam.mirrored or j not in grays:
                continue
            if j not in self._prints:
                self._prints[j] = _footprint(cam, self._weak_mask(j, grays[j]))
            if _continues(o, mine, self._prints[j], reach=LONELY_REACH, both=False, cover=LONELY_COVER, turn=LONELY_TURN):
                log.info("camera %d: the only view of this dart is the end of a streak camera %d sees - no dart", o.camera + 1, j + 1)
                return True
        return False

    def _seen_elsewhere(self, idx: int, x: float, y: float, grays: dict[int, np.ndarray], shadows: dict[int, np.ndarray]) -> bool:
        """Does another camera see a change where this dart would be - at its tip and the part of the dart
        in front of it? Weak changes count (a black dart on a black field), shadow / light does not.
        True when no other camera can tell (none sees that spot)."""
        looked = False
        weak = self.settings.diffThreshold * LOW_THRESHOLD
        edge = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * SHADOW_EDGE + 1, 2 * SHADOW_EDGE + 1))
        for j, cam in self.cams.items():
            g = grays.get(j)
            if j == idx or cam.mirrored or g is None or cam.ref is None or cam.ref.shape != g.shape or cam.H is None:
                continue
            tip = apply_h(cam.H, [[x, y]])[0]
            h, w = g.shape
            if not (0 <= tip[0] < w and 0 <= tip[1] < h):
                continue
            looked = True
            n = cam.normal_direction(tip)
            end = tip + (n * TIP_WINDOW if n is not None else 0)
            sel = np.zeros((h, w), np.uint8)
            cv2.line(sel, (int(round(tip[0])), int(round(tip[1]))), (int(round(end[0])), int(round(end[1]))), 1, 9)
            changed = (cv2.absdiff(g, cam.ref) > weak) & (sel > 0)
            light = shadows.get(j)
            if light is not None and light.shape == changed.shape:
                changed &= cv2.dilate(light, edge) == 0  # what the shadow filter took for light (and its soft edge)
            if int(changed.sum()) >= 6:
                return True
        return not looked

    def _dart_views(self, grays: dict[int, np.ndarray], masks: dict[int, np.ndarray], skip: set[int] | None = None) -> set[int]:
        """Cameras that see a dart shaped object (long and thin, not a shadow) in front of the board.

        masks: the changes of every camera (the other cameras tell whether something lies flat on the
        board); skip: cameras that do not need to be looked at again.
        """
        s = self.settings
        lo = BOUNCE_AREA * s.minDartArea
        seen: set[int] = set()
        prints: dict[int, np.ndarray | None] = {}
        for idx, mask in masks.items():
            if skip and idx in skip:
                continue
            cam = self.cams[idx]
            if cam.mirrored or cam.ref is None:
                continue
            area = cv2.countNonZero(mask)
            if area < lo or area >= s.takeoutArea:
                continue
            # a shadow that leaves shows the empty board again: no new object in front of it
            mask = self._only_new(idx, mask, grays[idx])
            whole: list[bool] = []  # is everything that changed in this camera only darker / brighter?
            n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
            # the biggest pieces: long and thin (cheap) and not just darker / brighter (shadow)
            for i in (1 + np.argsort(-stats[1:, cv2.CC_STAT_AREA]))[:3]:
                x, y, w, h, area = (int(v) for v in stats[i])
                if area < s.minDartArea:
                    break
                ys, xs = np.nonzero(labels[y : y + h, x : x + w] == i)
                ev = np.linalg.eigvalsh(np.cov(np.vstack([xs, ys]).astype(np.float64)))
                if math.sqrt(ev[1] / max(ev[0], 1e-6)) < BOUNCE_ELONGATION:
                    continue
                pad = LIGHT_WINDOW
                x0, y0 = max(0, x - pad), max(0, y - pad)
                x1, y1 = min(mask.shape[1], x + w + pad), min(mask.shape[0], y + h + pad)
                sel = labels[y0:y1, x0:x1] == i
                if _light_only(grays[idx][y0:y1, x0:x1], cam.ref[y0:y1, x0:x1], sel, strict=False):
                    continue
                if not whole:
                    # a shadow falls apart into slivers (sector by sector); one sliver alone can look
                    # like something new, all of them together are clearly the darker board
                    whole.append(cv2.countNonZero(_without_light(grays[idx], cam.ref, mask, strict=False)) == 0)
                if whole[0]:
                    break
                # a thin shadow / light streak: the other cameras see it at the same board place
                piece = _footprint(cam, labels == i)
                others = [j for j in masks if j != idx and not self.cams[j].mirrored]
                for j in others:
                    if j not in prints:
                        prints[j] = _footprint(self.cams[j], self._weak_mask(j, grays[j]))
                if any(_flat(piece, prints[j]) for j in others):
                    self._motion_flat = True
                    break
                seen.add(idx)
                break
        return seen

    def _bounced_out(self) -> bool:
        """A short motion in front of the board in which a dart was seen, and that left nothing behind.

        Shadows (the player walking back or aiming) also cause short motions that leave nothing
        behind - without the dart shaped object in at least two cameras they are no bounce-out.
        """
        s = self.settings
        if not getattr(s, "bounceOut", 1) or self.state != "throw" or self.darts >= 3:
            return False
        if self._motion_hand or self._motion_flat or self._motion_start < self._quiet_until or self._motion_last - self._motion_start > BOUNCE_MAX_S:
            return False
        lo = BOUNCE_AREA * s.minDartArea
        seen = [p for p in self._motion_peak.values() if p >= lo]
        if any(p >= s.takeoutArea for p in self._motion_peak.values()):
            return False
        need = min(2, sum(1 for c in self.cams.values() if not c.mirrored))
        return need > 0 and len(seen) >= need and len(self._motion_darts) >= need

    def _add_bounce_out(self, events: list[tuple], fulls: dict[int, np.ndarray] | None = None, areas=None, raw_areas=None) -> None:
        log.info("bounce-out: dart hit the board and dropped (peaks %s, dart seen by cameras %s)", self._motion_peak, sorted(self._motion_darts))
        dart_id = uuid.uuid4().hex
        self._keep("bounce", fulls or {}, {"areas": areas, "rawAreas": raw_areas, "dartSeenBy": sorted(self._motion_darts)}, dart_id)
        self.darts += 1
        if self.darts >= 3:
            self.state = "takeout"
            events.append(("state",))
        events.append(
            ("dart", {"id": dart_id, "seg": {"number": 0, "multiplier": 0}, "confidence": 0.5, "cameras": [], "out": "bounce"})
        )
        events.append(("state",))

    def _keep(self, kind: str, fulls: dict[int, np.ndarray], info: dict, ident: str | None = None) -> None:
        """Remember the camera images of a detection for bug reports (before the references move on).

        before = what the detector compared against, after = the calm image it evaluated, peak = the
        image with the most motion in between (the dart in flight, a hand, a shadow).
        """
        (self.discarded if kind == "discarded" else self.evidence).append(
            {
                "id": ident or uuid.uuid4().hex,
                "kind": kind,
                "at": time.time(),
                "state": self.state,
                "darts": self.darts,
                "before": {i: c.ref_full for i, c in self.cams.items() if c.ref_full is not None},
                "after": dict(fulls),
                "peak": dict(self._motion_frames),
                "info": {
                    **info,
                    "motionPeak": dict(self._motion_peak),
                    "motionSeconds": round(self._motion_last - self._motion_start, 2),
                },
            }
        )

    def _analyze(self, idx: int, mask: np.ndarray, full: np.ndarray | None = None, gray: np.ndarray | None = None) -> Observation | None:
        cam = self.cams[idx]
        blob = self._dart_blob(cam, mask, gray)
        if blob is None:
            return None
        self._blobs[idx] = blob
        ys, xs = np.nonzero(blob)
        if len(xs) < max(8, self.settings.minDartArea // 3):
            return None
        pts = np.column_stack([xs, ys]).astype(np.float64)
        mean = pts.mean(axis=0)
        evals, evecs = np.linalg.eigh(np.cov((pts - mean).T))
        v = evecs[:, 1]
        t = (pts - mean) @ v
        length = float(t.max() - t.min())
        area = len(xs)
        # The blob was found in the small processing image, the axis is fitted on the full resolution
        # frames: a triple/double ring is only 2-3 px tall there, a one pixel error is ~1.5 mm on the board.
        if length >= 5 and full is not None and cam.scaled and cam.ref_full is not None and cam.ref_full.shape == full.shape:
            fpts, occ = self._full_points(cam, blob, xs, ys, full)
            if fpts is not None:
                s = cam.full_size[0] / cam.size[0]
                fm = fpts.mean(axis=0)
                fv = np.linalg.eigh(np.cov((fpts - fm).T))[1][:, 1]
                ft = (fpts - fm) @ fv
                if float(ft.max() - ft.min()) < 6 * s:
                    return None
                return self._fit(cam, fpts, s, True, length, area, occ)
        if length < 10:
            return None
        return self._fit(cam, pts, 1.0, False, length, area)

    def _dart_blob(self, cam: CameraState, mask: np.ndarray, gray: np.ndarray | None = None) -> np.ndarray | None:
        """The new dart in the change mask (bool image), or None."""
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

        def size(m: list[int]) -> int:
            return sum(int(stats[i, cv2.CC_STAT_AREA]) for i in m)

        def plain(m: list[int]) -> bool:
            """Only darker / brighter than before (a shadow that moved with the throw)?"""
            if gray is None or cam.ref is None or size(m) < LIGHT_MIN_PX:
                return False
            x0 = min(int(stats[i, 0]) for i in m)
            y0 = min(int(stats[i, 1]) for i in m)
            x1 = max(int(stats[i, 0] + stats[i, 2]) for i in m)
            y1 = max(int(stats[i, 1] + stats[i, 3]) for i in m)
            pad = LIGHT_WINDOW
            x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
            x1, y1 = min(mask.shape[1], x1 + pad), min(mask.shape[0], y1 + pad)
            sel = np.isin(labels[y0:y1, x0:x1], m)
            return _light_only(gray[y0:y1, x0:x1], cam.ref[y0:y1, x0:x1], sel, strict=False)

        groups = sorted(clusters.values(), key=size, reverse=True)
        if len(groups) > 1:
            # the biggest region that is not just a shadow; if every region is plain, the biggest one
            # (a black dart on a cream sector also only makes the image darker)
            groups = [m for m in groups[:4] if not plain(m)] + groups
        return np.isin(labels, groups[0])

    def _full_points(
        self, cam: CameraState, blob: np.ndarray, xs: np.ndarray, ys: np.ndarray, full: np.ndarray
    ) -> tuple[np.ndarray | None, tuple[np.ndarray, int, int] | None]:
        """Changed pixels of the full resolution frame around the blob (x, y in full resolution pixels),
        plus a mask of the older darts in that region (mask, x0, y0) if the empty board is known."""
        (w, h), (fw, fh) = cam.size, cam.full_size
        sx, sy = fw / w, fh / h
        pad = 3
        px0, px1 = max(0, int(xs.min()) - pad), min(w, int(xs.max()) + 1 + pad)
        py0, py1 = max(0, int(ys.min()) - pad), min(h, int(ys.max()) + 1 + pad)
        x0, x1 = int(round(px0 * sx)), min(fw, int(round(px1 * sx)))
        y0, y1 = int(round(py0 * sy)), min(fh, int(round(py1 * sy)))
        if x1 - x0 < 4 or y1 - y0 < 4:
            return None, None
        # the blob of the small image is blurred (wider than the dart): a small margin is enough
        near = cv2.dilate(blob[py0:py1, px0:px1].astype(np.uint8), np.ones((3, 3), np.uint8))
        near = cv2.resize(near, (x1 - x0, y1 - y0), interpolation=cv2.INTER_NEAREST)
        k = (FULL_BLUR, FULL_BLUR)
        cur = cv2.GaussianBlur(full[y0:y1, x0:x1], k, 0)
        ref = cv2.GaussianBlur(cam.ref_full[y0:y1, x0:x1], k, 0)
        thr = self.settings.diffThreshold
        lo = thr * LOW_THRESHOLD
        diff = cv2.absdiff(cur, ref)
        changed = (diff > lo) & (near > 0)
        if cam.empty_full is not None and cam.empty_full is not cam.ref_full and cam.empty_full.shape == full.shape:
            # a dart that fell out at the same time leaves the empty board behind, not a new dart
            changed &= cv2.absdiff(cur, cv2.GaussianBlur(cam.empty_full[y0:y1, x0:x1], k, 0)) > lo
        # hysteresis: weak pixels only where they are connected to clear ones
        n, labels = cv2.connectedComponents(changed.astype(np.uint8), connectivity=8)
        keep = np.unique(labels[changed & (diff > thr)])
        changed = np.isin(labels, keep[keep > 0])
        fy, fx = np.nonzero(changed)
        if len(fx) < max(8, self.settings.minDartArea // 3) * sx * sy:
            return None, None
        occ = None
        if cam.empty_full is not None and cam.empty_full.shape == full.shape:
            # darts thrown before this one: in the reference, but not on the empty board
            empty = cv2.GaussianBlur(cam.empty_full[y0:y1, x0:x1], k, 0)
            old = (cv2.absdiff(ref, empty) > thr).astype(np.uint8)
            occ = (cv2.dilate(old, np.ones((3, 3), np.uint8)) > 0, x0, y0)
        return np.column_stack([fx + x0, fy + y0]).astype(np.float64), occ

    def _fit(
        self, cam: CameraState, pts: np.ndarray, s: float, full: bool, length: float, area: int,
        occ: tuple[np.ndarray, int, int] | None = None,
    ) -> Observation | None:
        """Fit the dart axis on the blob points (pixels of a 1/s scaled processing image) -> board line."""
        idx = cam.index
        Hinv = cam.Hfinv if full else cam.Hinv
        mean = pts.mean(axis=0)
        # 1) initial axis, oriented from the tip towards the flight
        dn = cam.normal_direction(mean, full)
        if dn is not None:
            away = dn  # darts stand roughly perpendicular on the board
        else:
            evals, evecs = np.linalg.eigh(np.cov((pts - mean).T))
            v = evecs[:, 1]
            t = (pts - mean) @ v
            perp = (pts - mean) @ np.array([-v[1], v[0]])
            band = 0.18 * float(t.max() - t.min())
            w_min = float(perp[t < t.min() + band].std())
            w_max = float(perp[t > t.max() - band].std())
            away = v if w_min <= w_max else -v  # the flight end is the wide one

        # 2) remove the (wide) flight, keep point + barrel (+ shaft) for the axis fit
        thin, flight = _split_flight(pts, mean, away, s)
        if len(thin) >= 10 * s * s:
            vx, vy, x0, y0 = cv2.fitLine(thin.astype(np.float32), cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
            d = np.array([vx, vy], dtype=np.float64)
            p0 = np.array([x0, y0], dtype=np.float64)
            if d @ away < 0:
                d = -d
            p0, d = _slice_axis(thin, p0, d, occ)
            proj = (thin - p0) @ d
            extent = float(proj.max() - proj.min())
            near = thin[proj < proj.min() + 1.5 * s]
            tip_img = p0 + d * float(((near - p0) @ d).mean())
            # thin part: reliable direction; if the flight is visible too, the axis must pass through it
            weight = min(1.0, extent / (35.0 * s))
            if len(flight) >= 10 * s * s:
                fc = flight.mean(axis=0)
                off = abs(float((fc - p0) @ np.array([-d[1], d[0]])))
                if off > 6 * s:
                    weight *= 0.5
        else:
            # only the flight is visible: assume the dart is perpendicular to the board
            if dn is None:
                return None
            d = dn
            proj = (pts - mean) @ d
            tip_img = mean + d * float(proj.min())
            extent = length * s
            weight = 0.08
        # small blobs (far away, mostly hidden) give wrong lines much more often
        weight *= min(1.0, max(0.4, area / (1.5 * self.settings.minDartArea)))
        far_img = tip_img + d * max(25.0 * s, extent)
        tip_b, far_b = apply_h(Hinv, [tip_img, far_img])
        u = far_b - tip_b
        norm = float(np.linalg.norm(u))
        if norm < 1e-6:
            return None
        u /= norm
        normal = np.array([-u[1], u[0]])
        return Observation(idx, tip_b, normal, float(normal @ tip_b), length, area, max(weight, 0.05))


def _slice_axis(pts: np.ndarray, p0: np.ndarray, d: np.ndarray, occ: tuple[np.ndarray, int, int] | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Refine an axis (p0, d): robust line through the centres of 1 px wide cross sections of the dart.

    The centre between both edges is independent of how many pixels of a cross section pass the
    threshold inside (a dark shaft in front of a dark segment). Cross sections with an edge next to
    an older dart (occ) are skipped: there the new dart is partly hidden behind it or invisible in
    front of it, so its centre would be shifted.
    """
    n = np.array([-d[1], d[0]])
    t = (pts - p0) @ d
    q = (pts - p0) @ n
    b = np.floor(t - t.min()).astype(int)
    nb = int(b.max()) + 1
    cnt = np.bincount(b, minlength=nb)
    ok = cnt > 0
    lo = np.full(nb, np.inf)
    hi = np.full(nb, -np.inf)
    np.minimum.at(lo, b, q)
    np.maximum.at(hi, b, q)
    tc = np.bincount(b, t, nb) / np.maximum(cnt, 1)
    mid = np.zeros(nb)
    mid[ok] = (lo[ok] + hi[ok]) / 2
    if occ is not None:
        mask, ox, oy = occ
        hidden = np.zeros(nb, bool)
        for edge in (lo - 2.0, hi + 2.0):  # the pixel just outside each edge
            e = np.where(ok, edge, 0.0)
            px = np.rint(p0[0] + tc * d[0] + e * n[0]).astype(int) - ox
            py = np.rint(p0[1] + tc * d[1] + e * n[1]).astype(int) - oy
            inside = ok & (px >= 0) & (py >= 0) & (px < mask.shape[1]) & (py < mask.shape[0])
            hidden[inside] |= mask[py[inside], px[inside]]
        clear = ok & ~hidden
        if clear.sum() >= max(6, 0.4 * ok.sum()):
            ok = clear
    if ok.sum() < 4:
        return p0, d
    centres = p0 + np.outer(tc[ok], d) + np.outer(mid[ok], n)
    vx, vy, x0, y0 = cv2.fitLine(centres.astype(np.float32), cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
    d2 = np.array([vx, vy], dtype=np.float64)
    return np.array([x0, y0], dtype=np.float64), (d2 if d2 @ d >= 0 else -d2)


def _split_flight(pts: np.ndarray, mean: np.ndarray, away: np.ndarray, s: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
    """Split blob points into the thin part (point/barrel/shaft) and the wide flight (s = pixel scale)."""
    perp_dir = np.array([-away[1], away[0]])
    t = (pts - mean) @ away
    q = (pts - mean) @ perp_dir
    t0 = t.min()
    bins = ((t - t0) // (3 * s)).astype(int)
    nb = int(bins.max()) + 1
    lo = np.full(nb, np.inf)
    hi = np.full(nb, -np.inf)
    np.minimum.at(lo, bins, q)
    np.maximum.at(hi, bins, q)
    filled = np.isfinite(lo)
    width = np.where(filled, hi - lo + 1, 0)
    ref = np.percentile(width[filled], 30) if np.any(filled) else 1
    wide = width > max(7.0 * s, 2.5 * ref)
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


INLIER_MM = 5.0  # max. distance of a board line from the intersection
TIP_BEHIND_MM = 6.0  # the visible tip can be hidden (further along the line), but not in front of the intersection


def _behind(o: Observation, X: np.ndarray) -> float:
    """Distance of the visible tip from X along the board line, positive = away from the camera."""
    return float((o.tip_board - X) @ np.array([o.normal[1], -o.normal[0]]))


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
            # the image of a dart starts at its tip: a line whose visible tip lies clearly in front of X
            # (towards its camera) does not belong to a dart at X
            inliers = [o for o in obs if abs(float(o.normal @ X - o.offset)) < INLIER_MM and _behind(o, X) > -TIP_BEHIND_MM]
            if a not in inliers or b not in inliers:
                # X contradicts what one of the two cameras saw itself: not a candidate (with a broken
                # camera this used to pick a point somewhere on the line of a good one)
                continue
            # ties (three lines, one of them wrong: every pair has two inliers) -> the better conditioned pair
            angle = abs(float(np.linalg.det(np.array([a.normal, b.normal]))))
            score_ = (round(sum(o.weight for o in inliers), 6), round(a.weight + b.weight, 6), angle)
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
