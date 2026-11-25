"""Thin shadow / light streaks are no darts (0.4.3).

Recorded with 0.4.2 at the office: somebody walked past a lamp and a thin, straight shadow line swept over
the board. In every single camera that line looks exactly like a dart (long and thin, not a flat shadow
region), so the board counted darts nobody threw - and when the line moved on, it reported them as
"fallen out". Seen by several cameras, the line is at the same place on the board for all of them; a
dart sticks out of the board and is somewhere else for every camera except at its tip.
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
from tests.test_shadows import darts, frame  # noqa: E402


def office_settings() -> Settings:
    """The settings of the board in the recordings."""
    s = Settings()
    s.diffThreshold, s.minDartArea, s.takeoutArea, s.settleFrames = 28, 40, 6000, 3
    return s


CALIB_ERROR_PX = (1.0, 1.0, 2.5)  # like the accuracy benchmark: the cameras' calibrations never agree exactly


def make(seed: int, settings: Settings | None = None, calib: float = 1.0):
    world = SimWorld(cameras=3, seed=seed)
    det = Detector(settings or office_settings())
    rng = np.random.default_rng(seed)
    for i in range(3):
        e = CALIB_ERROR_PX[i] * calib
        det.set_calibration(i, [(x + rng.uniform(-e, e) / world.width, y + rng.uniform(-e, e) / world.height) for x, y in world.calibration(i)])
    return world, det


def streak(c: float, angle: float, depth: float = 0.5, width: float = 2.0):
    """a thin straight line over the whole board, at distance c (mm) from the centre"""
    a = math.radians(angle)
    return (-math.sin(a) * c, -math.cos(a) * c, 200.0, width, 3, angle, depth)


def sweep(angle: float, depth: float, width: float, start: float = -150, step: float = 12, n: int = 26, pause: int = 5, skip=None):
    """the line moves over the board and stops every three steps (that is when the board evaluates)"""
    seq = []
    for k in range(n):
        c = start + step * k
        if skip and skip[0] <= c <= skip[1]:
            continue
        seq += [[streak(c, angle, depth, width)]] * (pause if k % 3 == 2 else 1)
    return seq


def run(world, det, sequence, before: int = 4, after: int = 8, only=None):
    frames = [[]] * before + sequence + [[]] * after
    events = []
    for n, shadows in enumerate(frames):
        f = frame(world, shadows, n + 1)
        if only is not None:  # the streak only in this camera (a reflection only one camera sees)
            clean = frame(world, [], n + 1)
            f = {i: (img if i == only else clean[i]) for i, img in f.items()}
        events += det.process(f)
    return events


CASES = [(30, 0.5, 2.0), (-40, 0.6, 3.0), (0, 0.5, 1.5), (75, -0.6, 2.0), (120, 0.45, 4.0)]


def test_thin_streaks_are_no_darts():
    for n, ((angle, depth, width), calib) in enumerate([(c, 0.0) for c in CASES] + [((a + 7, d, w), 2.0) for a, d, w in CASES]):
        world, det = make(200 + n, calib=calib)
        events = run(world, det, sweep(angle, depth, width))
        kinds = [e[0] for e in events]
        assert darts(events) == [], (angle, depth, darts(events))
        assert "dart_out" not in kinds and "takeout_started" not in kinds, (angle, kinds)
        assert det.darts == 0 and det.state == "throw"
        assert any(e["info"]["reason"] == "flat" for e in det.discarded), [e["info"]["reason"] for e in det.discarded]


def test_streak_in_one_camera_only_is_no_dart():
    # a light reflection that only one camera sees: the others see nothing where that dart would be
    for cam in range(3):
        world, det = make(220 + cam)
        events = run(world, det, sweep(35 + 40 * cam, -0.6, 2.0, start=-90, n=15), only=cam)
        assert darts(events) == [], (cam, darts(events))
        assert det.darts == 0


def test_dart_is_found_while_a_streak_passes():
    cases = [((60.0, -80.0), 30), ((-100.0, 40.0), -40), ((10.0, 100.0), 75)]
    for n, ((x, y), angle) in enumerate(cases):
        world, det = make(240 + n)
        run(world, det, [], after=0)
        world.throw(x, y)
        found = darts(run(world, det, [], before=0, after=8))
        assert len(found) == 1, (n, found)
        assert math.hypot(found[0]["x"] - x, found[0]["y"] - y) < 5, (n, found[0], (x, y))
        # the streak sweeps over the board, also over the dart: it stays where it is
        events = run(world, det, sweep(angle, 0.55, 2.5), before=0)
        assert darts(events) == [] and "dart_out" not in [e[0] for e in events], (n, events)
        assert det.darts == 1


def test_darts_land_while_a_streak_is_on_the_board():
    # the streak stays where it is while darts are thrown elsewhere
    for n, angle in enumerate((20, -65)):
        world, det = make(260 + n)
        line = [streak(-120, angle, 0.5, 2.0)]
        run(world, det, [line] * 12, after=0)
        for x, y in [(40.0, 60.0), (-30.0, -90.0), (80.0, -20.0)]:
            world.throw(x, y)
            found = darts(run(world, det, [line] * 8, before=0, after=0))
            assert len(found) == 1, (n, (x, y), found)
            assert (found[0]["seg"]["number"], found[0]["seg"]["multiplier"]) == g.score(x, y), (n, found[0], (x, y))
        assert det.darts == 3


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(name, "ok")
