"""Bug reports: the board keeps the camera images of its last detections and sends them on request.

Run: python -m pytest board/tests -q
"""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from autodarter_board.app import BoardApp  # noqa: E402
from autodarter_board.config import Settings  # noqa: E402
from autodarter_board.detector import EVIDENCE_KEEP  # noqa: E402
from tests.test_shadows import SPOT, darts, make, run  # noqa: E402


class FakeCam:
    def __init__(self, index: int, frame: np.ndarray):
        self.index = index
        self._frame = frame

    def latest(self):
        return 1, self._frame


def fake_app(world, det):
    cams = [FakeCam(i, world.render(i)) for i in range(3)]
    return SimpleNamespace(
        detector=det,
        cameras=SimpleNamespace(streams=cams),
        store=SimpleNamespace(settings=Settings()),
        status=lambda: {"state": "throw"},
        calibration_by_index=lambda: {},
    )


def throw(world, det, x: float, y: float) -> dict:
    world.throw(x, y)
    found = darts(run(world, det, [], before=0, after=10))
    assert len(found) == 1, found
    return found[0]


def test_dart_images_are_kept():
    world, det = make(31)
    run(world, det, [], after=0)
    d = throw(world, det, 40.0, 95.0)
    e = det.evidence[-1]
    assert (e["id"], e["kind"]) == (d["id"], "dart")
    assert e["info"]["seg"] == d["seg"]
    assert sorted(e["before"]) == sorted(e["after"]) == [0, 1, 2]
    for cam in range(3):
        before, after = e["before"][cam], e["after"][cam]
        assert before.shape == after.shape == (world.height, world.width)  # full resolution
        assert cv2.countNonZero((cv2.absdiff(before, after) > 40).astype(np.uint8)) > 50  # the dart is on it
    assert e["peak"], "the frame with the most motion (dart in flight)"


def test_only_the_last_darts_are_kept_and_shadows_apart():
    world, det = make(32)
    run(world, det, [], after=0)
    ids = []
    for k in range(EVIDENCE_KEEP + 2):
        if k % 3 == 0 and k:
            world.clear_darts()
            run(world, det, [], before=0, after=12)
            det.reset()
            run(world, det, [], before=0, after=2)
        ids.append(throw(world, det, -60.0 + 9 * k, 50.0)["id"])
    assert [e["id"] for e in det.evidence] == ids[-EVIDENCE_KEEP:]
    # a shadow that comes and stays is no dart - its change is kept separately (missed darts end up there)
    run(world, det, [[SPOT]] * 10, before=0, after=0)
    assert [e["id"] for e in det.evidence] == ids[-EVIDENCE_KEEP:]
    assert det.discarded and det.discarded[-1]["info"]["reason"] in ("shadow", "too_small", "no_dart_found")


def test_report_contains_lossless_images_once():
    world, det = make(33)
    run(world, det, [], after=0)
    first = throw(world, det, 30.0, -70.0)
    second = throw(world, det, -45.0, 20.0)
    files, info = BoardApp.collect_report(fake_app(world, det), [first["id"], second["id"], "unknown"], 0)
    names = [f[0] for f in files]
    assert len(names) == len(set(names))
    assert info["missing"] == ["unknown"]
    assert [e["id"] for e in info["entries"]] == [first["id"], second["id"]]
    # the image after the first dart is the one the second was compared against: sent once
    one, two = info["entries"]
    for cam in ("0", "1", "2"):
        assert one["frames"][cam]["after"] == two["frames"][cam]["before"]
        assert info["now"][cam]["live"] == f"now-cam{int(cam) + 1}-live.jpg"
    # lossless: the detector can replay the report exactly
    by_name = {n: data for n, _, data in files}
    e = det.evidence[-1]
    png = cv2.imdecode(np.frombuffer(by_name[two["frames"]["0"]["after"]], np.uint8), cv2.IMREAD_UNCHANGED)
    assert np.array_equal(png, e["after"][0])
    assert info["entries"][1]["info"]["seg"] == second["seg"]


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(name, "ok")
