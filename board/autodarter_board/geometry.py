"""Dartboard geometry (mirrors shared/src/board.ts).

Board coordinates: millimetres, origin at the bull, x to the right, y up.
"""
from __future__ import annotations

import math

import cv2
import numpy as np

SECTORS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5]

DOUBLE_BULL = 6.35
BULL = 15.9
TRIPLE_INNER = 99.0
TRIPLE_OUTER = 107.0
DOUBLE_INNER = 162.0
DOUBLE_OUTER = 170.0
BOARD_RADIUS = 225.5


def _on_double_outer(angle_deg: float) -> tuple[float, float]:
    a = math.radians(angle_deg)
    return DOUBLE_OUTER * math.cos(a), DOUBLE_OUTER * math.sin(a)


# Same order as CALIBRATION_POINTS in shared/src/board.ts
CALIBRATION_POINTS: list[tuple[float, float]] = [
    _on_double_outer(81),  # 20 | 1
    _on_double_outer(-9),  # 6 | 10
    _on_double_outer(-99),  # 3 | 19
    _on_double_outer(171),  # 11 | 14
    (0.0, 0.0),  # bull
]
CALIBRATION_LABELS = ["20 | 1", "6 | 10", "3 | 19", "11 | 14", "Bull"]


def score(x: float, y: float) -> tuple[int, int]:
    """Return (number, multiplier); number 25 = bull, (0, 0) = miss."""
    r = math.hypot(x, y)
    if r <= DOUBLE_BULL:
        return 25, 2
    if r <= BULL:
        return 25, 1
    if r > DOUBLE_OUTER:
        return 0, 0
    angle = math.degrees(math.atan2(y, x))
    idx = int(((90 - angle + 9) % 360) // 18) % 20
    number = SECTORS[idx]
    if TRIPLE_INNER <= r <= TRIPLE_OUTER:
        return number, 3
    if r >= DOUBLE_INNER:
        return number, 2
    return number, 1


def segment_label(number: int, multiplier: int) -> str:
    if multiplier == 0 or number == 0:
        return "MISS"
    if number == 25:
        return "BULL" if multiplier == 2 else "25"
    if multiplier == 1:
        return str(number)
    return ("T" if multiplier == 3 else "D") + str(number)


def board_to_image_homography(points_norm: list[tuple[float, float]], width: int, height: int) -> np.ndarray | None:
    """Homography mapping board mm -> image pixels from normalised calibration points."""
    if len(points_norm) != len(CALIBRATION_POINTS):
        return None
    src = np.array(CALIBRATION_POINTS, dtype=np.float64)
    dst = np.array([(p[0] * width, p[1] * height) for p in points_norm], dtype=np.float64)
    H, _ = cv2.findHomography(src, dst, 0)
    return H


def apply_h(H: np.ndarray, pts) -> np.ndarray:
    arr = np.asarray(pts, dtype=np.float64).reshape(-1, 1, 2)
    return cv2.perspectiveTransform(arr, H).reshape(-1, 2)


def estimate_pose(H: np.ndarray, width: int, height: int):
    """Camera pose from a board->image homography (Zhang's constraints, principal point = image centre).

    Returns (K, R, t) with board coordinates x right, y up, z out of the board towards the player.
    """
    T = np.array([[1, 0, -width / 2], [0, 1, -height / 2], [0, 0, 1.0]])
    Hc = T @ H
    h1, h2 = Hc[:, 0], Hc[:, 1]
    # unknown a = 1/f^2:  r1.r2 = 0  and  |r1| = |r2|
    A = np.array([h1[0] * h2[0] + h1[1] * h2[1], h1[0] ** 2 + h1[1] ** 2 - h2[0] ** 2 - h2[1] ** 2])
    B = np.array([h1[2] * h2[2], h1[2] ** 2 - h2[2] ** 2])
    denom = float(A @ A)
    a = -float(A @ B) / denom if denom > 1e-18 else -1.0
    f = 1 / math.sqrt(a) if a > 0 else 0.8 * width
    f = min(max(f, 0.3 * width), 5 * width)
    K = np.array([[f, 0, width / 2], [0, f, height / 2], [0, 0, 1.0]])
    M = np.linalg.inv(K) @ H
    lam = 1 / np.linalg.norm(M[:, 0])
    if M[2, 2] * lam < 0:
        lam = -lam
    r1, r2, t = M[:, 0] * lam, M[:, 1] * lam, M[:, 2] * lam
    r2 = r2 - r1 * (r1 @ r2)  # re-orthogonalise
    r2 /= np.linalg.norm(r2)
    r3 = np.cross(r1, r2)
    R = np.column_stack([r1, r2, r3])
    return K, R, t


def project3d(K: np.ndarray, R: np.ndarray, t: np.ndarray, pts) -> np.ndarray:
    P = np.asarray(pts, dtype=np.float64).reshape(-1, 3)
    cam = (R @ P.T).T + t
    uv = (K @ cam.T).T
    return uv[:, :2] / uv[:, 2:3]


def circle_points(radius: float, steps: int = 72) -> np.ndarray:
    a = np.linspace(0, 2 * np.pi, steps, endpoint=False)
    return np.column_stack([radius * np.cos(a), radius * np.sin(a)])
