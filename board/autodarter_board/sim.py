"""Synthetic dartboard + cameras for development and tests (CAMERA_SOURCE=sim).

Renders a board texture through real pinhole camera models placed on a ring around the
board (like an Autodarts setup) and draws 3D darts and a hand on top.
"""
from __future__ import annotations

import math
import random
import threading
import time

import cv2
import numpy as np

from . import geometry as g

PX_PER_MM = 2.4
TEX_R = 235.0


def _board_texture() -> np.ndarray:
    size = int(2 * TEX_R * PX_PER_MM)
    c = size / 2
    yy, xx = np.mgrid[0:size, 0:size]
    x = (xx - c) / PX_PER_MM
    y = -(yy - c) / PX_PER_MM
    r = np.hypot(x, y)
    ang = np.degrees(np.arctan2(y, x))
    idx = (((90 - ang + 9) % 360) // 18).astype(int) % 20
    dark = idx % 2 == 0
    img = np.zeros((size, size, 3), np.uint8)
    img[:] = (52, 52, 52)  # wall
    black, cream = np.array([28, 28, 30]), np.array([170, 210, 228])
    red, green = np.array([45, 40, 190]), np.array([60, 135, 35])
    single = np.where(dark[..., None], black, cream)
    ring = np.where(dark[..., None], red, green)
    board = r <= g.BOARD_RADIUS
    img[board] = (22, 22, 24)
    sel = r <= g.DOUBLE_OUTER
    img[sel] = single[sel]
    tri = (r >= g.TRIPLE_INNER) & (r <= g.TRIPLE_OUTER)
    dbl = (r >= g.DOUBLE_INNER) & (r <= g.DOUBLE_OUTER)
    img[tri] = ring[tri]
    img[dbl] = ring[dbl]
    img[r <= g.BULL] = green
    img[r <= g.DOUBLE_BULL] = red
    wire = (190, 190, 190)
    for rad in (g.DOUBLE_OUTER, g.DOUBLE_INNER, g.TRIPLE_OUTER, g.TRIPLE_INNER, g.BULL, g.DOUBLE_BULL):
        cv2.circle(img, (int(c), int(c)), int(rad * PX_PER_MM), wire, 1, cv2.LINE_AA)
    for i in range(20):
        a = math.radians(81 - i * 18)
        p1 = (int(c + g.BULL * PX_PER_MM * math.cos(a)), int(c - g.BULL * PX_PER_MM * math.sin(a)))
        p2 = (int(c + g.DOUBLE_OUTER * PX_PER_MM * math.cos(a)), int(c - g.DOUBLE_OUTER * PX_PER_MM * math.sin(a)))
        cv2.line(img, p1, p2, wire, 1, cv2.LINE_AA)
    for i, n in enumerate(g.SECTORS):
        a = math.radians(90 - i * 18)
        rr = 197 * PX_PER_MM
        pos = (int(c + rr * math.cos(a) - 14), int(c - rr * math.sin(a) + 10))
        cv2.putText(img, str(n), pos, cv2.FONT_HERSHEY_SIMPLEX, 1.0, (235, 235, 235), 2, cv2.LINE_AA)
    return img


class SimCameraModel:
    def __init__(self, angle_deg: float, width: int, height: int, ring: float = 340.0, out: float = 240.0, fov: float = 85.0):
        a = math.radians(angle_deg)
        self.C = np.array([ring * math.cos(a), ring * math.sin(a), out])
        f = -self.C / np.linalg.norm(self.C)
        up = np.array([0.0, 0.0, 1.0])
        right = np.cross(f, up)
        right /= np.linalg.norm(right)
        down = np.cross(f, right)
        self.R = np.vstack([right, down, f])
        self.t = -self.R @ self.C
        focal = (width / 2) / math.tan(math.radians(fov / 2))
        self.K = np.array([[focal, 0, width / 2], [0, focal, height / 2], [0, 0, 1.0]])
        self.focal = focal
        self.width, self.height = width, height
        # board plane (z=0) -> image
        self.H = self.K @ np.column_stack([self.R[:, 0], self.R[:, 1], self.t])

    def project(self, P: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        cam = (self.R @ np.asarray(P, dtype=np.float64).T).T + self.t
        depth = cam[:, 2]
        uv = (self.K @ cam.T).T
        return uv[:, :2] / uv[:, 2:3], depth


class SimWorld:
    """Board state shared by all simulated cameras."""

    def __init__(self, cameras: int = 3, width: int = 1280, height: int = 720, seed: int | None = None):
        self.rng = random.Random(seed)
        self.texture = _board_texture()
        self.width, self.height = width, height
        # camera 0 centred over the 6 (right), then 120° steps – none over the 20
        self.models = [SimCameraModel(0 + i * 120, width, height) for i in range(cameras)]
        tex_c = self.texture.shape[0] / 2
        self.T_tex = np.array([[1 / PX_PER_MM, 0, -tex_c / PX_PER_MM], [0, -1 / PX_PER_MM, tex_c / PX_PER_MM], [0, 0, 1]])
        self.base = [
            cv2.warpPerspective(self.texture, m.H @ self.T_tex, (width, height), flags=cv2.INTER_LINEAR, borderValue=(52, 52, 52))
            for m in self.models
        ]
        self.darts: list[tuple[np.ndarray, np.ndarray]] = []
        self.hand: np.ndarray | None = None
        self.version = 0
        self.lock = threading.Lock()
        nrng = np.random.default_rng(seed)
        self.noise = [nrng.normal(0, 2.0, (height, width, 3)).astype(np.int16) for _ in range(4)]

    # ----------------------------------------------------------- world changes
    def throw(self, x: float | None = None, y: float | None = None, tilt: float = 0.25) -> tuple[float, float]:
        if x is None or y is None:
            r = self.rng.uniform(0, 175) ** 1.0
            a = self.rng.uniform(0, 2 * math.pi)
            x, y = r * math.cos(a), r * math.sin(a)
        d = np.array([self.rng.uniform(-tilt, tilt), self.rng.uniform(-tilt, tilt), 1.0])
        d /= np.linalg.norm(d)
        with self.lock:
            self.darts.append((np.array([x, y, 0.0]), d))
            self.version += 1
        return x, y

    def set_hand(self, pos: tuple[float, float] | None) -> None:
        with self.lock:
            self.hand = None if pos is None else np.array([pos[0], pos[1], 70.0])
            self.version += 1

    def clear_darts(self) -> None:
        with self.lock:
            self.darts.clear()
            self.version += 1

    def takeout(self) -> None:
        """Animated takeout: hand comes in, pulls the darts, leaves (≈1.5 s)."""
        target = self.darts[0][0][:2] if self.darts else (0.0, 0.0)

        def run():
            self.set_hand((float(target[0]), float(target[1])))
            time.sleep(0.7)
            self.clear_darts()
            time.sleep(0.6)
            self.set_hand(None)

        threading.Thread(target=run, daemon=True).start()

    def calibration(self, cam: int) -> list[tuple[float, float]]:
        m = self.models[cam]
        pts = g.apply_h(m.H, g.CALIBRATION_POINTS)
        return [(float(p[0] / self.width), float(p[1] / self.height)) for p in pts]

    # ----------------------------------------------------------- rendering
    def render(self, cam: int, noise: int = 0) -> np.ndarray:
        m = self.models[cam]
        with self.lock:
            darts = list(self.darts)
            hand = None if self.hand is None else self.hand.copy()
        img = self.base[cam].copy()
        parts = []  # (depth, draw-fn)
        for tip, d in darts:
            for a, b, radius, color in ((0, 22, 1.0, (185, 185, 190)), (22, 65, 3.6, (75, 72, 70)), (65, 100, 1.6, (25, 25, 25))):
                pa, pb = tip + d * a, tip + d * b
                uv, depth = m.project(np.array([pa, pb]))
                th = max(1, int(round(2 * radius * m.focal / float(depth.mean()))))
                parts.append((float(depth.mean()), ("line", uv, th, color)))
            e1 = np.cross(d, [0, 0, 1.0])
            if np.linalg.norm(e1) < 1e-6:
                e1 = np.array([1.0, 0, 0])
            e1 /= np.linalg.norm(e1)
            e2 = np.cross(d, e1)
            for e in (e1, e2):
                quad = np.array([tip + d * 95 + e * 2, tip + d * 138 + e * 16, tip + d * 138 - e * 16, tip + d * 95 - e * 2])
                uv, depth = m.project(quad)
                parts.append((float(depth.mean()), ("poly", uv, 0, (190, 90, 30))))
        if hand is not None:
            circle = np.array([[hand[0] + 75 * math.cos(t), hand[1] + 60 * math.sin(t), hand[2]] for t in np.linspace(0, 2 * math.pi, 28)])
            uv, depth = m.project(circle)
            if np.all(depth > 50):
                parts.append((float(depth.mean()), ("poly", uv, 0, (120, 155, 205))))
            arm = np.array([hand, hand + np.array([0, -120, 260])])
            uv, depth = m.project(arm)
            if np.all(depth > 50):
                th = max(2, int(2 * 45 * m.focal / float(depth.mean())))
                parts.append((float(depth.mean()), ("line", uv, th, (110, 145, 195))))
        for _, (kind, uv, th, color) in sorted(parts, key=lambda p: -p[0]):
            pts = np.round(uv).astype(np.int32)
            if kind == "line":
                cv2.line(img, tuple(pts[0]), tuple(pts[1]), color, th, cv2.LINE_AA)
            else:
                cv2.fillConvexPoly(img, pts, color, cv2.LINE_AA)
        if noise:
            img = np.clip(img.astype(np.int16) + self.noise[noise % len(self.noise)], 0, 255).astype(np.uint8)
        return img


class SimCamera(threading.Thread):
    """Camera stream backed by the SimWorld (same interface as cameras.CameraStream)."""

    def __init__(self, world: SimWorld, index: int, fps: int):
        super().__init__(daemon=True, name=f"simcam-{index}")
        self.world, self.index, self.fps = world, index, fps
        self.device = f"sim://{index}"
        self.cam_id = f"sim-{index}"
        self.name = f"Simulierte Kamera {index + 1}"
        self.width, self.height = world.width, world.height
        self._frame: np.ndarray | None = None
        self._frame_id = 0
        self._lock = threading.Lock()
        self._running = True
        self.ok = True
        self.measured_fps = 0.0

    def run(self) -> None:
        cached_version, cached = -1, None
        n = 0
        last = time.time()
        while self._running:
            start = time.time()
            if self.world.version != cached_version:
                cached_version = self.world.version
                cached = self.world.render(self.index)
            n += 1
            noisy = np.clip(cached.astype(np.int16) + self.world.noise[n % len(self.world.noise)], 0, 255).astype(np.uint8)
            with self._lock:
                self._frame = noisy
                self._frame_id += 1
            if time.time() - last >= 1:
                self.measured_fps = n / (time.time() - last)
                n, last = 0, time.time()
            time.sleep(max(0.0, 1 / self.fps - (time.time() - start)))

    def latest(self) -> tuple[int, np.ndarray | None]:
        with self._lock:
            return self._frame_id, self._frame

    def stop(self) -> None:
        self._running = False
