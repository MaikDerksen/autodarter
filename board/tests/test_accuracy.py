"""Accuracy benchmark of the dart detection with the synthetic board.

pytest runs a reduced version with fixed seeds and accuracy thresholds. Run the file directly for
the full benchmark and an analysis of the worst cases:

    python board/tests/test_accuracy.py                       # both scenarios, 300 darts each
    python board/tests/test_accuracy.py --scenario real --darts 600 --jpeg 85 --worst 15

Scenarios:
  sim   the stock simulator geometry: double ring ~605 px wide, ellipse ratio ~0.61 (cameras 35°
        above the board plane)
  real  closer to the real Pi setup: double ring ~480 px wide at 1280x720, ellipse ratio ~0.47
        (cameras 25° above the board plane, wide angle lens) -> triple/double ring only 3-8 px tall

Every round clears the board and throws three darts (earlier darts stay in and can occlude the next
one). The throws mix uniformly random darts, darts within 0.3-2.5 mm of a wire, darts in the thin
rings (triple, double, 25, bull) and tight groups around T20/T19/bull etc. Darts are tilted by up
to ~23°, frames get sensor noise (optionally JPEG artefacts like MJPEG cameras) and the calibration
points of the cameras are off by up to 1, 1 and 2.5 px. The darts are rendered with sub-pixel
precision (the stock simulator rounds all end points to whole pixels).
"""
from __future__ import annotations

import argparse
import math
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from autodarter_board import geometry as g  # noqa: E402
from autodarter_board.config import Settings  # noqa: E402
from autodarter_board.detector import Detector  # noqa: E402
from autodarter_board.sim import SimCameraModel, SimWorld  # noqa: E402

# camera geometry: angle of the first camera (120° steps), ring radius and distance in front of the board (mm), fov
SCENARIOS = {
    "sim": dict(angle=0.0, ring=340.0, out=240.0, fov=85.0),
    "real": dict(angle=15.0, ring=320.0, out=150.0, fov=110.0),
}
CALIB_ERROR_PX = (1.0, 1.0, 2.5)  # per camera, at 1280x720
TILT = 0.3  # max. tangent of the dart tilt per axis
SHIFT = 4  # sub-pixel bits for drawing
RING_WIRES = (g.DOUBLE_BULL, g.BULL, g.TRIPLE_INNER, g.TRIPLE_OUTER, g.DOUBLE_INNER, g.DOUBLE_OUTER)
# point, barrel, shaft and flight colours (BGR) – "dark": black darts, which on the cream sectors
# only make the image darker (like a shadow) and on the black ones are hardly visible
DART_COLORS = {
    "light": ((185, 185, 190), (75, 72, 70), (25, 25, 25), (190, 90, 30)),
    "dark": ((150, 150, 155), (38, 36, 36), (20, 20, 20), (28, 28, 30)),
}
COLORS = DART_COLORS["light"]
GROUP_AIMS = [(20, 3), (19, 3), (18, 3), (20, 1), (25, 2), (16, 2), (20, 2), (14, 3)]


class BenchWorld(SimWorld):
    """SimWorld with configurable camera geometry, noise level, JPEG artefacts and sub-pixel rendering."""

    def __init__(self, scenario: str = "real", seed: int = 0, noise: float = 2.5, jpeg: int = 0, subpixel: bool = True,
                 edge_calib: bool = True):
        super().__init__(cameras=3, seed=seed)
        self.edge_calib = edge_calib
        geo = SCENARIOS[scenario]
        w, h = self.width, self.height
        self.models = [
            SimCameraModel(geo["angle"] + i * 120, w, h, ring=geo["ring"], out=geo["out"], fov=geo["fov"]) for i in range(3)
        ]
        self.base = [
            cv2.warpPerspective(self.texture, m.H @ self.T_tex, (w, h), flags=cv2.INTER_LINEAR, borderValue=(52, 52, 52))
            for m in self.models
        ]
        nrng = np.random.default_rng(seed + 7919)
        # 7 noise patterns (coprime to the 4 frames per dart, so reference and evaluation frame never share one)
        self.noise_pool = []
        for _ in range(7):
            n = np.round(nrng.normal(0, noise, (h, w, 3)))
            self.noise_pool.append((np.clip(n, 0, 255).astype(np.uint8), np.clip(-n, 0, 255).astype(np.uint8)))
        self.jpeg = jpeg
        self.subpixel = subpixel
        self._cache: dict[tuple[int, int], np.ndarray] = {}

    def calibration(self, cam: int) -> list[tuple[float, float]]:
        """Like the app: normalised edge coordinates (pixel centre of OpenCV pixel i = (i + 0.5) / width)."""
        if not self.edge_calib:
            return super().calibration(cam)
        pts = g.apply_h(self.models[cam].H, g.CALIBRATION_POINTS) + 0.5
        return [(float(p[0] / self.width), float(p[1] / self.height)) for p in pts]

    def set_darts(self, darts: list[tuple[np.ndarray, np.ndarray]]) -> None:
        with self.lock:
            self.darts = list(darts)
            self.version += 1

    def scene(self, cam: int) -> np.ndarray:
        key = (cam, self.version)
        if key not in self._cache:
            self._cache = {k: v for k, v in self._cache.items() if k[1] == self.version}
            self._cache[key] = self._draw(cam) if self.subpixel else self.render(cam)
        return self._cache[key]

    def _draw(self, cam: int) -> np.ndarray:
        """Same dart model as SimWorld.render, drawn with sub-pixel end points."""
        m = self.models[cam]
        img = self.base[cam].copy()
        parts = []
        for tip, d in self.darts:
            for a, b, radius, color in ((0, 22, 1.0, COLORS[0]), (22, 65, 3.6, COLORS[1]), (65, 100, 1.6, COLORS[2])):
                uv, depth = m.project(np.array([tip + d * a, tip + d * b]))
                th = max(1, int(round(2 * radius * m.focal / float(depth.mean()))))
                parts.append((float(depth.mean()), "line", uv, th, color))
            e1 = np.cross(d, [0, 0, 1.0])
            if np.linalg.norm(e1) < 1e-6:
                e1 = np.array([1.0, 0, 0])
            e1 /= np.linalg.norm(e1)
            e2 = np.cross(d, e1)
            for e in (e1, e2):
                quad = np.array([tip + d * 95 + e * 2, tip + d * 138 + e * 16, tip + d * 138 - e * 16, tip + d * 95 - e * 2])
                uv, depth = m.project(quad)
                parts.append((float(depth.mean()), "poly", uv, 0, COLORS[3]))
        for _, kind, uv, th, color in sorted(parts, key=lambda p: -p[0]):
            pts = np.round(uv * (1 << SHIFT)).astype(np.int32)
            if kind == "line":
                cv2.line(img, tuple(int(v) for v in pts[0]), tuple(int(v) for v in pts[1]), color, th, cv2.LINE_AA, SHIFT)
            else:
                cv2.fillConvexPoly(img, pts, color, cv2.LINE_AA, SHIFT)
        return img

    def frame(self, cam: int, tick: int) -> np.ndarray:
        pos, neg = self.noise_pool[tick % len(self.noise_pool)]
        img = cv2.subtract(cv2.add(self.scene(cam), pos), neg)
        if self.jpeg:
            img = cv2.imdecode(cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, self.jpeg])[1], cv2.IMREAD_COLOR)
        return img


# ---------------------------------------------------------------------- throws
def _polar(r: float, deg: float) -> tuple[float, float]:
    a = math.radians(deg)
    return r * math.cos(a), r * math.sin(a)


def _segment_point(number: int, multiplier: int) -> tuple[float, float]:
    if number == 25:
        return 0.0, 0.0
    deg = 90 - g.SECTORS.index(number) * 18
    r = {3: (g.TRIPLE_INNER + g.TRIPLE_OUTER) / 2, 2: (g.DOUBLE_INNER + g.DOUBLE_OUTER) / 2, 1: 135.0}[multiplier]
    return _polar(r, deg)


def _target(rng: np.random.Generator, kind: str) -> tuple[float, float]:
    if kind == "random":
        return _polar(170 * math.sqrt(rng.uniform()), rng.uniform(0, 360))
    off = rng.uniform(0.3, 2.5) * rng.choice([-1, 1])
    if kind == "wire":
        if rng.uniform() < 0.5:  # next to a radial wire
            deg = 81 - int(rng.integers(20)) * 18
            r = rng.uniform(22, 166)
            x, y = _polar(r, deg)
            n = np.array(_polar(1.0, deg + 90))
            return x + off * n[0], y + off * n[1]
        rad = RING_WIRES[int(rng.integers(len(RING_WIRES)))]
        return _polar(max(0.5, rad + off), rng.uniform(0, 360))
    # thin rings: triple, double, 25, bull
    which = int(rng.integers(4))
    if which == 0:
        return _polar(103 + rng.uniform(-3.7, 3.7), rng.uniform(0, 360))
    if which == 1:
        return _polar(166 + rng.uniform(-3.7, 3.7), rng.uniform(0, 360))
    return _polar(rng.uniform(0.0, 15.5) if which == 2 else rng.uniform(0.0, 6.0), rng.uniform(0, 360))


def make_rounds(rng: np.random.Generator, darts: int) -> list[list[tuple[str, float, float, np.ndarray]]]:
    rounds = []
    while sum(len(r) for r in rounds) < darts:
        group = rng.uniform() < 0.3
        aim = _segment_point(*GROUP_AIMS[int(rng.integers(len(GROUP_AIMS)))])
        rnd: list[tuple[str, float, float, np.ndarray]] = []
        while len(rnd) < 3:
            if group:
                kind = "group"
                x, y = aim[0] + rng.normal(0, 9), aim[1] + rng.normal(0, 9)
            else:
                kind = ("random", "wire", "ring")[int(rng.choice(3, p=[0.4, 0.35, 0.25]))]
                x, y = _target(rng, kind)
            if any(math.hypot(x - o[1], y - o[2]) < 7 for o in rnd):  # darts can not stick in each other
                continue
            d = np.array([rng.uniform(-TILT, TILT), rng.uniform(-TILT, TILT), 1.0])
            rnd.append((kind, float(x), float(y), d / np.linalg.norm(d)))
        rounds.append(rnd)
    return rounds


# ---------------------------------------------------------------------- benchmark
@dataclass
class Throw:
    kind: str
    true: tuple[float, float]
    found: tuple[float, float] | None
    seg_ok: bool
    error: float  # mm, inf if not found
    events: int
    dart: dict | None


def run(scenario: str = "real", darts: int = 300, seed: int = 1, noise: float = 2.5, jpeg: int = 0, subpixel: bool = True,
        calib_error: tuple[float, ...] = CALIB_ERROR_PX, edge_calib: bool = True,
        settings: Settings | None = None) -> tuple[list[Throw], list[float]]:
    world = BenchWorld(scenario, seed=seed, noise=noise, jpeg=jpeg, subpixel=subpixel, edge_calib=edge_calib)
    det = Detector(settings or Settings())
    rng = np.random.default_rng(seed)
    for i in range(3):
        e = calib_error[i]
        pts = [(x + rng.uniform(-e, e) / world.width, y + rng.uniform(-e, e) / world.height) for x, y in world.calibration(i)]
        det.set_calibration(i, pts)
    eval_times: list[float] = []
    if hasattr(det, "_evaluate"):
        orig = det._evaluate

        def timed(*args, **kwargs):
            t0 = time.perf_counter()
            try:
                return orig(*args, **kwargs)
            finally:
                eval_times.append(time.perf_counter() - t0)

        det._evaluate = timed

    tick_no = [0]

    def tick() -> list[tuple]:
        tick_no[0] += 1
        return det.process({i: world.frame(i, tick_no[0]) for i in range(3)})

    results: list[Throw] = []
    for rnd in make_rounds(rng, darts):
        world.set_darts([])
        det.reset()
        tick()
        stuck: list[tuple[np.ndarray, np.ndarray]] = []
        for kind, x, y, d in rnd:
            if len(results) >= darts:
                break
            stuck.append((np.array([x, y, 0.0]), d))
            world.set_darts(stuck)
            events: list[tuple] = []
            n_eval = len(eval_times)
            for _ in range(det.settings.settleFrames + 4):
                events += tick()
                if len(eval_times) > n_eval:
                    break
            found = [e[1] for e in events if e[0] == "dart"]
            dart = found[0] if found else None
            if dart:
                err = math.hypot(dart["x"] - x, dart["y"] - y)
                seg_ok = (dart["seg"]["number"], dart["seg"]["multiplier"]) == g.score(x, y)
                results.append(Throw(kind, (x, y), (dart["x"], dart["y"]), seg_ok, err, len(found), dart))
            else:
                results.append(Throw(kind, (x, y), None, False, math.inf, 0, None))
    return results, eval_times


@dataclass
class Summary:
    darts: int
    found: int
    accuracy: float  # % correct segments (missing darts count as wrong)
    mean: float
    p95: float
    max: float
    eval_ms: float

    def __str__(self) -> str:
        return (
            f"{self.darts} darts, found {self.found}, segments {self.accuracy:.1f} %, error mean {self.mean:.2f} / "
            f"p95 {self.p95:.2f} / max {self.max:.2f} mm, {self.eval_ms:.1f} ms per evaluation"
        )


def summarize(results: list[Throw], eval_times: list[float]) -> Summary:
    errs = np.array([r.error for r in results if r.found is not None])
    return Summary(
        darts=len(results),
        found=len(errs),
        accuracy=100.0 * sum(r.seg_ok for r in results) / max(1, len(results)),
        mean=float(errs.mean()) if len(errs) else math.inf,
        p95=float(np.percentile(errs, 95)) if len(errs) else math.inf,
        max=float(errs.max()) if len(errs) else math.inf,
        eval_ms=1000 * float(np.mean(eval_times)) if eval_times else 0.0,
    )


def report(name: str, results: list[Throw], eval_times: list[float], worst: int = 0) -> Summary:
    s = summarize(results, eval_times)
    print(f"[{name}] {s}")
    for kind in ("random", "wire", "ring", "group"):
        sub = [r for r in results if r.kind == kind]
        if sub:
            print(f"    {kind:7s} {summarize(sub, [])}".replace(", 0.0 ms per evaluation", ""))
    if worst:
        for r in sorted(results, key=lambda r: -r.error)[:worst]:
            found = "-" if r.found is None else f"({r.found[0]:7.2f},{r.found[1]:7.2f}) {g.segment_label(*g.score(*r.found))}"
            print(
                f"    {r.kind:7s} true ({r.true[0]:7.2f},{r.true[1]:7.2f}) {g.segment_label(*g.score(*r.true)):4s} -> {found:28s} "
                f"err {r.error:6.2f} mm  cams {r.dart['cameras'] if r.dart else '-'}  conf {r.dart['confidence'] if r.dart else '-'}"
            )
    return s


# ---------------------------------------------------------------------- pytest
# scenario, darts, seed, calibration error scale, min. segment accuracy %, max. mean / p95 tip error (mm).
# Measured, current detector:          98.9 % 0.45/1.35 mm | 95.6 % 0.95/1.88 mm | 96.7 % 0.62/1.15 mm
# Previous detector (640 px analysis): 95.6 % 1.89/5.69 mm | 86.7 % 2.13/8.30 mm | 93.3 % 0.79/1.43 mm
BENCHMARK = (
    ("real", 90, 12, 0.0, 95.0, 0.7, 2.0),  # perfect calibration: precision of the detection itself
    ("real", 90, 14, 1.0, 92.0, 1.3, 2.8),  # realistic setup incl. calibration error
    ("sim", 60, 13, 1.0, 93.0, 1.0, 2.0),
)


def test_accuracy_benchmark():
    """Reduced benchmark (240 darts, ~20 s). Thresholds leave some margin to the measured values."""
    for scenario, darts, seed, calib, min_acc, max_mean, max_p95 in BENCHMARK:
        results, times = run(scenario, darts=darts, seed=seed, calib_error=tuple(e * calib for e in CALIB_ERROR_PX))
        s = report(f"{scenario} calib x{calib}", results, times)
        assert s.found == darts, s
        assert all(r.events == 1 for r in results)
        assert s.accuracy >= min_acc, s
        assert s.mean <= max_mean, s
        assert s.p95 <= max_p95, s


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scenario", choices=[*SCENARIOS, "all"], default="all")
    ap.add_argument("--darts", type=int, default=300)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--noise", type=float, default=2.5, help="sensor noise sigma (grey levels)")
    ap.add_argument("--jpeg", type=int, default=0, help="JPEG quality of the frames (0 = off)")
    ap.add_argument("--pixel", action="store_true", help="draw darts like the stock simulator (whole pixels)")
    ap.add_argument("--calib", type=float, default=1.0, help="scale of the calibration error (0 = perfect calibration)")
    ap.add_argument("--center", action="store_true", help="calibration points like the stock simulator (pixel centre / width)")
    ap.add_argument("--worst", type=int, default=10)
    ap.add_argument("--darts-color", choices=list(DART_COLORS), default="light", help="dark = black darts")
    args = ap.parse_args()
    COLORS = DART_COLORS[args.darts_color]
    for sc in SCENARIOS if args.scenario == "all" else [args.scenario]:
        t0 = time.perf_counter()
        calib = tuple(e * args.calib for e in CALIB_ERROR_PX)
        res, times = run(sc, args.darts, args.seed, args.noise, args.jpeg, not args.pixel, calib, not args.center)
        report(sc, res, times, args.worst)
        print(f"    ({time.perf_counter() - t0:.1f} s)")
