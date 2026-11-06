"""End-to-end detection test with the synthetic board (no hardware needed).

Run: python -m pytest board/tests -q   (or python board/tests/test_detection.py)
"""
from __future__ import annotations

import math
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from autodarter_board.config import Settings  # noqa: E402
from autodarter_board.detector import Detector  # noqa: E402
from autodarter_board.geometry import score  # noqa: E402
from autodarter_board.sim import SimWorld  # noqa: E402


def make(seed: int = 1, calib_error_px: float = 0.0):
    world = SimWorld(cameras=3, seed=seed)
    det = Detector(Settings())
    for i in range(3):
        pts = world.calibration(i)
        if calib_error_px:
            pts = [
                (x + world.rng.uniform(-calib_error_px, calib_error_px) / world.width, y + world.rng.uniform(-calib_error_px, calib_error_px) / world.height)
                for x, y in pts
            ]
        det.set_calibration(i, pts)
    return world, det


def tick(world, det, n: int = 1, frame: list[int] = [0]):
    events = []
    for _ in range(n):
        frame[0] += 1
        events += det.process({i: world.render(i, noise=frame[0]) for i in range(3)})
    return events


def throw_and_detect(world, det, x=None, y=None):
    tick(world, det, 2)
    true = world.throw(x, y)
    events = tick(world, det, 1)  # motion frame
    events += tick(world, det, det.settings.settleFrames + 1)
    darts = [e[1] for e in events if e[0] == "dart"]
    return true, darts


def takeout(world, det):
    events = []
    world.set_hand((0, 0))
    events += tick(world, det, 2)
    world.clear_darts()
    events += tick(world, det, 2)
    world.set_hand(None)
    events += tick(world, det, 1 + det.settings.settleFrames * 2 + 1)
    return [e[0] for e in events]


def test_detects_darts_accurately():
    world, det = make(seed=3)
    errors = []
    correct = 0
    total = 0
    for _ in range(4):
        for _ in range(3):
            true, darts = throw_and_detect(world, det)
            assert len(darts) == 1, f"expected exactly one dart, got {darts}"
            d = darts[0]
            err = math.hypot(d["x"] - true[0], d["y"] - true[1])
            errors.append(err)
            total += 1
            if (d["seg"]["number"], d["seg"]["multiplier"]) == score(*true):
                correct += 1
        assert det.state == "takeout"
        names = takeout(world, det)
        assert "takeout_started" in names and "takeout_finished" in names, names
        assert det.state == "throw" and det.darts == 0
    print(f"median error {statistics.median(errors):.2f} mm, max {max(errors):.2f} mm, segments {correct}/{total}")
    assert statistics.median(errors) < 3.0
    assert correct / total >= 0.9


def test_specific_targets():
    world, det = make(seed=5)
    for target in [(0, 103), (0, 166), (0, 0), (-103, 0)]:
        _, darts = throw_and_detect(world, det, *target)
        assert darts, target
        assert (darts[0]["seg"]["number"], darts[0]["seg"]["multiplier"]) == score(*target), (target, darts[0])
        det.reset()
        world.clear_darts()
        tick(world, det, 2)


def test_robust_to_small_calibration_error():
    world, det = make(seed=7, calib_error_px=3)
    errors = []
    for _ in range(3):
        true, darts = throw_and_detect(world, det)
        assert darts
        errors.append(math.hypot(darts[0]["x"] - true[0], darts[0]["y"] - true[1]))
    print(f"with calibration error: median {statistics.median(errors):.2f} mm")
    assert statistics.median(errors) < 6.0


def test_hand_without_change_restores_state():
    world, det = make(seed=9)
    throw_and_detect(world, det)
    assert det.darts == 1
    names = []
    world.set_hand((50, 50))
    names += [e[0] for e in tick(world, det, 2)]
    world.set_hand(None)
    names += [e[0] for e in tick(world, det, 1 + det.settings.settleFrames * 2 + 1)]
    assert "takeout_started" in names
    assert "takeout_finished" not in names
    assert det.state == "throw" and det.darts == 1


if __name__ == "__main__":
    test_detects_darts_accurately()
    test_specific_targets()
    test_robust_to_small_calibration_error()
    test_hand_without_change_restores_state()
    print("all detection tests passed")
