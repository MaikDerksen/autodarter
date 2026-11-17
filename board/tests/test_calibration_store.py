"""Saved calibrations must survive id changes of the cameras (udev links missing after boot etc.)."""
from types import SimpleNamespace

import numpy as np

from autodarter_board.app import BoardApp
from autodarter_board.config import Settings
from autodarter_board.detector import Detector

POINTS = [[0.4, 0.2], [0.7, 0.45], [0.55, 0.8], [0.25, 0.55], [0.5, 0.5]]


def cam(index, cam_id, aliases=()):
    return SimpleNamespace(index=index, cam_id=cam_id, aliases=tuple(aliases), device=f"/dev/video{index * 2}")


def fake_app(streams, calibration):
    saved = []
    store = SimpleNamespace(calibration=calibration, save_calibration=lambda: saved.append(dict(calibration)))
    app = SimpleNamespace(store=store, cameras=SimpleNamespace(streams=streams), detector=Detector(Settings()), saved=saved)
    app.resolve_calibration = lambda: BoardApp.resolve_calibration(app)
    return app


def test_old_udev_id_is_taken_over():
    streams = [cam(0, "platform-xhci-hcd.0-usb-0:1:1.0", ["video0"]), cam(1, "platform-xhci-hcd.1-usb-0:2:1.0", ["video2"])]
    app = fake_app(streams, {"video0": {"points": POINTS}, "platform-xhci-hcd.1-usb-0:2:1.0": {"points": POINTS}})
    BoardApp.apply_calibration(app)
    assert set(app.store.calibration) == {s.cam_id for s in streams}
    assert sorted(app.detector.cams) == [0, 1]
    assert app.saved


def test_new_ids_fall_back_to_the_same_camera_number():
    streams = [cam(0, "new-a"), cam(1, "new-b"), cam(2, "new-c")]
    cal = {
        "old-a": {"points": POINTS, "index": 0},
        "old-b": {"points": POINTS, "index": 1},
        "new-c": {"points": POINTS, "index": 2},
    }
    app = fake_app(streams, cal)
    BoardApp.apply_calibration(app)
    assert sorted(app.store.calibration) == ["new-a", "new-b", "new-c"]
    assert sorted(app.detector.cams) == [0, 1, 2]


def test_unplugged_camera_keeps_its_calibration():
    # camera 2 is missing: nothing may be reassigned or deleted
    streams = [cam(0, "a"), cam(1, "c")]
    cal = {"a": {"points": POINTS, "index": 0}, "b": {"points": POINTS, "index": 1}, "c": {"points": POINTS, "index": 2}}
    app = fake_app(streams, cal)
    BoardApp.apply_calibration(app)
    assert set(app.store.calibration) == {"a", "b", "c"}
    assert app.store.calibration["b"]["index"] == 1


def test_restore_from_server_backup():
    streams = [cam(0, "a"), cam(1, "b")]
    app = fake_app(streams, {"a": {"points": POINTS}})
    app.apply_calibration = lambda: BoardApp.apply_calibration(app)
    backup = {"b": {"points": [{"x": x, "y": y} for x, y in POINTS]}, "zzz": {"points": POINTS}}
    assert BoardApp.restore_calibration(app, backup)
    assert sorted(app.detector.cams) == [0, 1]
    assert app.store.calibration["b"]["points"][0] == POINTS[0]


def test_lights_off_and_on_create_no_darts():
    det = Detector(Settings())
    det.set_calibration(0, [tuple(p) for p in POINTS])
    det.set_calibration(1, [tuple(p) for p in POINTS])
    bright = np.full((480, 640, 3), 140, np.uint8)
    dark = np.full((480, 640, 3), 3, np.uint8)
    for _ in range(5):
        assert det.process({0: bright, 1: bright}) == []
    events = []
    for _ in range(10):
        events += det.process({0: dark, 1: dark})
    assert det.dark
    for _ in range(10):
        events += det.process({0: bright, 1: bright})
    assert not any(e[0] in ("dart", "takeout_started") for e in events)
    assert sorted(det.cams) == [0, 1]


def test_hand_is_not_mistaken_for_light():
    det = Detector(Settings())
    det.set_calibration(0, [tuple(p) for p in POINTS])
    det.set_calibration(1, [tuple(p) for p in POINTS])
    bright = np.full((480, 640, 3), 140, np.uint8)
    for _ in range(5):
        det.process({0: bright, 1: bright})
    hand = bright.copy()
    hand[100:480, 150:500] = 40  # a dark hand over a large part of camera 0 only
    events = det.process({0: hand, 1: bright})
    assert det._light_until == 0.0
    assert ("takeout_started",) in events
