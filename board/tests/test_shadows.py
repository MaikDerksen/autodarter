"""Shadows on the board are no darts.

The player standing at the line, aiming or walking back after pulling the darts throws a shadow on
the board. In 0.4.1 such a short shadow counted as a bounce-out (a MISS), a shadow that stayed as a
dart, and a shadow moving while a dart landed often took the dart's place.
Run: python -m pytest board/tests -q
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from autodarter_board import geometry as g  # noqa: E402
from autodarter_board.config import Settings  # noqa: E402
from autodarter_board.detector import Detector  # noqa: E402
from autodarter_board.sim import SimWorld  # noqa: E402

# (centre x, y, half axes, softness, angle, depth): an ellipse on the board (mm), its edge blurred by a
# Gaussian of `softness` mm, the light reduced by `depth`
Shadow = tuple[float, float, float, float, int, float, float]

ARM: Shadow = (-120.0, 40.0, 160.0, 35.0, 31, 20.0, 0.35)  # arm while aiming
SPOT: Shadow = (40.0, 60.0, 60.0, 60.0, 41, 0.0, 0.35)  # small, e.g. a hand far away
EDGE: Shadow = (150.0, -40.0, 50.0, 70.0, 41, 0.0, 0.4)  # at the edge of the board
BODY: Shadow = (-230.0, 0.0, 150.0, 220.0, 81, 0.0, 0.45)  # player in front of the light


def make(seed: int):
    world = SimWorld(cameras=3, seed=seed)
    det = Detector(Settings())
    for i in range(3):
        det.set_calibration(i, world.calibration(i))
    return world, det


def frame(world: SimWorld, shadows: list[Shadow], noise: int) -> dict[int, np.ndarray]:
    size = 600  # board canvas, 1 px = 1 mm, origin in the centre
    to_board = np.array([[1, 0, -size / 2], [0, -1, size / 2], [0, 0, 1.0]])
    out = {}
    for cam in range(3):
        img = world.render(cam, noise=noise).astype(np.float32)
        factor = np.ones(img.shape[:2], np.float32)
        for cx, cy, ax, ay, soft, angle, depth in shadows:
            m = np.zeros((size, size), np.float32)
            cv2.ellipse(m, (int(size / 2 + cx), int(size / 2 - cy)), (int(ax), int(ay)), angle, 0, 360, 1.0, -1)
            m = cv2.GaussianBlur(m, (soft | 1, soft | 1), 0)
            factor *= 1 - depth * cv2.warpPerspective(m, world.models[cam].H @ to_board, (world.width, world.height))
        out[cam] = np.clip(img * factor[..., None], 0, 255).astype(np.uint8)
    return out


def run(world, det, sequence: list[list[Shadow]], before: int = 3, after: int = 10) -> list[tuple]:
    frames = [[]] * before + sequence + [[]] * after
    events = []
    for n, shadows in enumerate(frames):
        events += det.process(frame(world, shadows, n + 1))
    return events


def darts(events):
    return [e[1] for e in events if e[0] == "dart"]


def moving(shadow: Shadow, steps: int, dx: float = 10.0, dy: float = 0.0) -> list[list[Shadow]]:
    cx, cy, *rest = shadow
    return [[(cx + dx * k, cy + dy * k, *rest)] for k in range(steps)]


def test_short_shadows_are_no_bounce_outs():
    for seed, sequence in [(5, [[SPOT]] * 3), (6, moving(ARM, 6)), (7, moving(EDGE, 3, 0, 15))]:
        world, det = make(seed)
        found = darts(run(world, det, sequence))
        assert found == [], (seed, found)
        assert det.darts == 0


def test_shadow_that_stays_is_no_dart():
    for seed, shadow in [(8, SPOT), (9, EDGE), (10, ARM), (11, BODY)]:
        world, det = make(seed)
        events = run(world, det, [[shadow]] * 10)  # comes, stays (calm), leaves
        assert darts(events) == [], (seed, darts(events))
        assert "takeout_finished" not in [e[0] for e in events]


def test_dart_is_found_while_a_shadow_moves():
    # the shadow elsewhere on the board. Known limit: a dart that lands inside the moving shadow (as
    # one camera sees it) forms one region with it there - that camera's line can be off.
    cases = [((60.0, -80.0), ARM), ((-100.0, -60.0), SPOT), ((120.0, 30.0), EDGE)]
    for n, ((x, y), shadow) in enumerate(cases):
        world, det = make(20 + n)
        events = run(world, det, [], after=0)
        world.throw(x, y)
        events = run(world, det, moving(shadow, 2, 12, -6) + [[shadow]] * 8, before=0, after=0)
        found = darts(events)
        assert len(found) == 1, (n, found)
        d = found[0]
        assert math.hypot(d["x"] - x, d["y"] - y) < 5, (n, d, (x, y))
        assert (d["seg"]["number"], d["seg"]["multiplier"]) == g.score(x, y)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(name, "ok")
