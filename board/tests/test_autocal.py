"""Automatic calibration (autocal.py) on the synthetic board.

Run: python -m pytest board/tests -q   (or python board/tests/test_autocal.py)
"""
from __future__ import annotations

import functools
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from autodarter_board import geometry as g  # noqa: E402
from autodarter_board.autocal import auto_calibrate  # noqa: E402
from autodarter_board.sim import SimWorld  # noqa: E402

W, H = 1280, 720
RINGS = np.vstack([g.circle_points(r, 72) for r in (g.DOUBLE_OUTER, g.TRIPLE_OUTER, g.TRIPLE_INNER, g.BULL)])


@functools.lru_cache(maxsize=1)
def world() -> SimWorld:
    w = SimWorld(cameras=3, seed=11)
    for x, y in ((40.0, 120.0), (-90.0, -30.0), (10.0, -150.0)):  # a few darts in the board
        w.throw(x, y)
    return w


def frame(cam: int) -> np.ndarray:
    return world().render(cam, noise=1 + cam)


def ring_error(points, truth) -> tuple[float, float]:
    """Mean / max px distance of the double, triple and bull rings projected with both calibrations."""
    Ha = g.board_to_image_homography(points, W, H)
    Ht = g.board_to_image_homography(truth, W, H)
    d = np.linalg.norm(g.apply_h(Ha, RINGS) - g.apply_h(Ht, RINGS), axis=1)
    return float(d.mean()), float(d.max())


def hint20(truth) -> tuple[float, float]:
    """Normalised image point in the middle of the single 20."""
    p = g.apply_h(g.board_to_image_homography(truth, W, H), [(0.0, 135.0)])[0]
    return float(p[0] / W), float(p[1] / H)


def moved(truth, dx: float, dy: float, rot: float = 0.0, scale: float = 1.0):
    """Calibration points moved in the image (dx, dy px), rotated (deg) and scaled about the bull."""
    pts = np.array(truth) * [W, H]
    c = pts[4]
    a = math.radians(rot)
    R = scale * np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
    out = (pts - c) @ R.T + c + [dx, dy]
    return [(float(x / W), float(y / H)) for x, y in out]


def test_refine_from_rough_points():
    rng = np.random.default_rng(5)
    for cam in range(3):
        truth = world().calibration(cam)
        prior = [(x + rng.uniform(-25, 25) / W, y + rng.uniform(-25, 25) / H) for x, y in truth]
        res = auto_calibrate(frame(cam), prior=prior)
        assert res["ok"] and res["mode"] == "refine" and not res["needsHint"], res
        mean, worst = ring_error(res["points"], truth)
        assert mean < 0.8 and worst < 1.5, (cam, mean, worst)
        assert res["score"] >= 0.8


def test_refine_after_camera_bump():
    truth = world().calibration(1)
    res = auto_calibrate(frame(1), prior=moved(truth, 45, -30, rot=6, scale=1.05))
    assert res["ok"], res
    mean, worst = ring_error(res["points"], truth)
    assert mean < 0.8 and worst < 1.5, (mean, worst)


def test_full_with_hint20():
    for cam in range(3):
        truth = world().calibration(cam)
        res = auto_calibrate(frame(cam), hint20=hint20(truth))
        assert res["ok"] and res["mode"] == "full" and not res["needsHint"], res
        mean, worst = ring_error(res["points"], truth)
        assert mean < 0.8 and worst < 1.5, (cam, mean, worst)


def test_full_with_prior_orientation():
    # old calibration far away from the board (camera moved a lot): it can't be refined,
    # but its rotation still tells which sector is the 20
    truth = world().calibration(2)
    res = auto_calibrate(frame(2), prior=moved(truth, 380, 250, rot=4, scale=0.6))
    assert res["ok"] and res["mode"] == "full" and not res["needsHint"], res
    mean, worst = ring_error(res["points"], truth)
    assert mean < 0.8 and worst < 1.5, (mean, worst)


def test_full_without_hint_asks_for_the_20():
    truth = world().calibration(0)
    res = auto_calibrate(frame(0))
    assert not res["ok"] and res["needsHint"] and res["mode"] == "full", res
    assert res["points"] is not None and len(res["points"]) == 5  # best guess for the UI
    # the guess is the board, just maybe rotated: the bull is right
    bull = np.array(res["points"][4]) * [W, H]
    assert np.linalg.norm(bull - np.array(truth[4]) * [W, H]) < 1.5
    assert "20" in res["message"]


def test_mirrored_prior_is_not_taken_over():
    # two points swapped (20|1 <-> 6|10, 3|19 <-> 11|14): rings and wires fit perfectly, but every
    # position is mirrored. Refining it would keep the mistake -> search again and ask for the 20.
    for cam in range(3):
        truth = world().calibration(cam)
        mirrored = [truth[1], truth[0], truth[3], truth[2], truth[4]]
        assert g.calibration_mirrored(mirrored) and not g.calibration_mirrored(truth)
        res = auto_calibrate(frame(cam), prior=mirrored)
        assert not res["ok"] and res["needsHint"] and "spiegelverkehrt" in res["message"], res
        assert not g.calibration_mirrored(res["points"])
        res = auto_calibrate(frame(cam), prior=mirrored, hint20=hint20(truth))
        assert res["ok"] and not res["needsHint"], res
        mean, worst = ring_error(res["points"], truth)
        assert mean < 0.8 and worst < 1.5, (cam, mean, worst)


def test_hint_must_not_be_on_the_bull():
    truth = world().calibration(0)
    p = g.apply_h(g.board_to_image_homography(truth, W, H), [(0.0, 3.0)])[0]
    res = auto_calibrate(frame(0), hint20=(p[0] / W, p[1] / H))
    assert not res["ok"] and res["needsHint"], res


def test_prior_rotated_by_almost_a_sector_is_ambiguous():
    truth = world().calibration(0)
    res = auto_calibrate(frame(0), prior=moved(truth, 0, 0, rot=20))
    assert not res["ok"] and res["needsHint"], res


def test_no_board():
    rng = np.random.default_rng(1)
    for img in (np.zeros((H, W, 3), np.uint8), np.full((H, W, 3), 128, np.uint8), rng.integers(0, 256, (H, W, 3), dtype=np.uint8)):
        for kwargs in ({}, {"hint20": (0.5, 0.5)}, {"prior": world().calibration(0)}):
            res = auto_calibrate(img, **kwargs)
            assert not res["ok"] and res["points"] is None, (kwargs, res)
            assert isinstance(res["message"], str) and res["message"]
    assert not auto_calibrate(None)["ok"]


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(name, "ok")
