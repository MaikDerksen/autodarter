import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from autodarter_board.geometry import CALIBRATION_POINTS, DOUBLE_OUTER, score, segment_label  # noqa: E402


def label(x, y):
    return segment_label(*score(x, y))


def test_scoring_matches_shared_engine():
    assert label(0, 0) == "BULL"
    assert label(0, 10) == "25"
    assert label(0, 103) == "T20"
    assert label(0, 166) == "D20"
    assert label(0, 140) == "20"
    assert label(0, 175) == "MISS"
    assert label(103, 0) == "T6"
    assert label(0, -103) == "T3"
    assert label(-103, 0) == "T11"
    a = math.radians(80)
    assert label(130 * math.cos(a), 130 * math.sin(a)) == "1"


def test_calibration_points_on_double_ring():
    for x, y in CALIBRATION_POINTS[:4]:
        assert abs(math.hypot(x, y) - DOUBLE_OUTER) < 1e-9
    assert CALIBRATION_POINTS[4] == (0.0, 0.0)
