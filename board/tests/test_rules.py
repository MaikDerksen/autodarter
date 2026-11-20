"""Bounce-outs, fall-outs and broken camera calibrations with the synthetic board.

Official rule: a dart that bounces out or falls out of the board before the player retrieves it does
not score (it still counts as thrown). Run: python -m pytest board/tests -q
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from autodarter_board import geometry as g  # noqa: E402
from autodarter_board.config import Settings  # noqa: E402
from autodarter_board.detector import Detector  # noqa: E402
from autodarter_board.sim import SimWorld  # noqa: E402


def make(seed: int, **settings):
    world = SimWorld(cameras=3, seed=seed)
    s = Settings()
    s.update(settings)
    det = Detector(s)
    for i in range(3):
        det.set_calibration(i, world.calibration(i))
    return world, det


def tick(world, det, n: int = 1, frame: list[int] = [0]):
    events = []
    for _ in range(n):
        frame[0] += 1
        events += det.process({i: world.render(i, noise=frame[0]) for i in range(3)})
    return events


def settle(world, det):
    return tick(world, det, 1) + tick(world, det, det.settings.settleFrames + 1)


def throw(world, det, x, y):
    tick(world, det, 2)
    true = world.throw(x, y)
    darts = [e[1] for e in settle(world, det) if e[0] == "dart"]
    assert len(darts) == 1, darts
    return true, darts[0]


def drop_dart(world, index: int) -> None:
    with world.lock:
        world.darts.pop(index)


def bounce(world, det, x: float, y: float, cams=(0, 1, 2)):
    """A dart hits at (x, y) and drops down in front of the board (only `cams` see it)."""
    tick(world, det, 2)
    events = []
    d = np.array([0.15, -0.35, 0.92])
    d /= np.linalg.norm(d)
    for k in range(3):
        dart = (np.array([x, y - 55.0 * k, 25.0 + 15.0 * k]), d)
        frames = {}
        for i in range(3):
            with world.lock:
                if i in cams:
                    world.darts.append(dart)
            frames[i] = world.render(i, noise=k + 1)
            with world.lock:
                if i in cams:
                    world.darts.pop()
        events += det.process(frames)
    return events + tick(world, det, det.settings.settleFrames + 1)


def outs(events):
    return [e[1] for e in events if e[0] == "dart_out"]


def darts(events):
    return [e[1] for e in events if e[0] == "dart"]


def test_dart_that_falls_out_is_reported():
    world, det = make(seed=21)
    _, d1 = throw(world, det, 60, 60)
    throw(world, det, -70, -40)
    drop_dart(world, 0)
    events = settle(world, det)
    assert outs(events) == [d1["id"]]
    assert darts(events) == []  # the hole is not a new dart
    assert det.darts == 2 and det.state == "throw"
    # nothing else happens afterwards
    assert outs(settle(world, det)) == []


def test_falls_out_while_the_next_dart_lands():
    world, det = make(seed=22)
    _, d1 = throw(world, det, 40, -90)
    tick(world, det, 2)
    drop_dart(world, 0)
    true = world.throw(-50, 100)
    events = settle(world, det)
    assert outs(events) == [d1["id"]]
    found = darts(events)
    assert len(found) == 1 and math.hypot(found[0]["x"] - true[0], found[0]["y"] - true[1]) < 5, found


def test_fall_out_after_the_third_dart():
    world, det = make(seed=24)
    first = throw(world, det, -20, 130)[1]
    throw(world, det, 100, 10)
    throw(world, det, -110, -60)
    assert det.state == "takeout"
    drop_dart(world, 0)
    assert outs(settle(world, det)) == [first["id"]]


def test_still_stuck_darts_are_not_reported():
    world, det = make(seed=25)
    throw(world, det, 30, 30)
    throw(world, det, 36, 22)  # right next to the first one, partly in front of it
    throw(world, det, -120, 40)
    assert outs(settle(world, det)) == []


def test_bounce_out_counts_as_miss():
    world, det = make(seed=26)
    events = bounce(world, det, 10, 120)
    found = darts(events)
    assert len(found) == 1 and found[0]["out"] == "bounce", found
    assert (found[0]["seg"]["number"], found[0]["seg"]["multiplier"]) == (0, 0)
    assert det.darts == 1
    # a real dart afterwards is detected normally
    true, d = throw(world, det, -60, 90)
    assert "out" not in d and math.hypot(d["x"] - true[0], d["y"] - true[1]) < 5


def test_no_bounce_out_from_one_camera_only_or_when_switched_off():
    world, det = make(seed=27)
    assert darts(bounce(world, det, 10, 120, cams=(1,))) == []  # e.g. an insect in front of one camera
    world, det = make(seed=27, bounceOut=0)
    assert darts(bounce(world, det, 10, 120)) == []
    assert det.darts == 0


def test_no_bounce_out_right_after_the_takeout():
    world, det = make(seed=28)
    throw(world, det, 50, -50)
    world.set_hand((0, 0))
    tick(world, det, 2)
    world.clear_darts()
    tick(world, det, 2)
    world.set_hand(None)
    names = [e[0] for e in tick(world, det, 1 + det.settings.settleFrames * 2 + 1)]
    assert "takeout_finished" in names
    # the player walks away: a short motion that leaves nothing behind
    assert darts(bounce(world, det, 0, 100)) == []
    det._quiet_until = 0.0  # a few seconds later
    assert [d.get("out") for d in darts(bounce(world, det, 0, 100))] == ["bounce"]


def test_mirrored_camera_is_ignored():
    world, det = make(seed=23)
    p = world.calibration(0)
    det.set_calibration(0, [p[1], p[0], p[3], p[2], p[4]])  # 20|1 <-> 6|10, 3|19 <-> 11|14
    assert det.camera_issue(0) == "mirrored" and det.camera_issue(1) is None
    for target in [(0, 120), (-90, 60), (70, -110)]:
        true, d = throw(world, det, *target)
        assert 0 not in d["cameras"], d
        assert math.hypot(d["x"] - true[0], d["y"] - true[1]) < 6, (true, d)


def test_camera_that_disagrees_is_reported():
    world, det = make(seed=29)
    # camera 2 calibrated one colour period (36 deg) off: rings and wires fit, numbers are wrong
    H = g.board_to_image_homography(world.calibration(1), world.width, world.height)
    a = math.radians(36)
    R = np.array([[math.cos(a), -math.sin(a), 0], [math.sin(a), math.cos(a), 0], [0, 0, 1.0]])
    pts = g.apply_h(H @ R, g.CALIBRATION_POINTS)
    det.set_calibration(1, [(float(x / world.width), float(y / world.height)) for x, y in pts])
    assert not g.calibration_mirrored(det.cams[1].points)
    rng = np.random.default_rng(3)
    for _ in range(4):
        for _ in range(3):
            r, t = 40 + 120 * rng.uniform(), rng.uniform(0, 2 * math.pi)
            throw(world, det, r * math.cos(t), r * math.sin(t))
        world.clear_darts()
        det.reset()
        tick(world, det, 2)
    assert det.camera_issue(1) == "inconsistent", list(det.agreement[1])
    assert det.camera_issue(0) is None and det.camera_issue(2) is None


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(name, "ok")
