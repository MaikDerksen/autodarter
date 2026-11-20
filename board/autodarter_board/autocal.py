"""Automatic board calibration from a single camera frame.

``auto_calibrate(frame, prior=None, hint20=None)`` finds the dartboard in a camera image, fits the
board(mm) -> image homography and returns the five calibration points in the order of
``geometry.CALIBRATION_POINTS`` (normalised image coordinates), i.e. exactly what the manual
calibration produces.

Pipeline
  1. Colour masks of the red/green ring paint (thresholds adapt to brightness and to how
     saturated the cream sectors are). Start homography: the ``prior`` points (refine) or an
     ellipse fitted to the outer edge of a ring-shaped colour blob (full).
  2. Coarse fit: the colour mask is scanned along board rays (polar unwarp through the current
     homography); the double/triple/bull runs give ring edge points; a robust Levenberg-Marquardt
     fit of all 8 homography parameters pulls the projected circles onto them (rotation free).
  3. Rotation: the red/green (and black/cream) sector pattern is correlated along the rings, which
     fixes the rotation modulo 36 deg -> 10 candidates; ``hint20`` or the ``prior`` picks one.
  4. Fine fit: sub-pixel edge search along the projected ring normals and across all 20 sector
     wires (expected colour change taken from the board's own colours, so it adapts to lighting),
     robust LM fit on those edges. The visible radius of each ring edge is estimated as well
     (on real boards the colour edge sits up to a wire width beside the nominal radius); the outer
     double edge keeps the scale. Score: share of the detected edges within 1.5 px of the fit.

Assumes an unmirrored camera image (like every V4L2 camera delivers it). A ``prior`` in mirrored
order (two calibration points swapped - the rings and wires fit, every position is mirrored) is
ignored: the board is searched from scratch and the result asks for ``hint20``.
A prior that is rotated by about a whole colour period (36 deg) cannot be told apart from the
right one; from ~12 deg on the result asks for ``hint20`` instead of guessing.
"""
from __future__ import annotations

import math

import cv2
import numpy as np

from . import geometry as g

__all__ = ["auto_calibrate", "OK_SCORE"]

OK_SCORE = 0.6  # minimum fit score for ok=True
_SHOW_SCORE = 0.35  # below this an unsure fit returns no points at all
_PRIOR_MAX_ROT = 12.0  # deg: a prior rotated further than this from the found board is ambiguous
_MIN_HINT_R = 12.0  # mm: a tap closer to the bull says nothing about the direction of the 20

_WIRES = (9.0 + 18.0 * np.arange(20)) % 360.0  # sector boundaries (board degrees)
_CAL_ANGLES = np.array([81.0, -9.0, -99.0, 171.0])  # outer calibration points (geometry.CALIBRATION_POINTS)

# classes for the fine edge search
_SURR, _BLACK, _CREAM, _RED, _GREEN, _BULL_G, _BULL_R = range(7)

_ERRORS = (np.linalg.LinAlgError, cv2.error, FloatingPointError, ValueError, ZeroDivisionError)


# --------------------------------------------------------------------------- small helpers
def _apply(H: np.ndarray, pts) -> np.ndarray:
    p = np.asarray(pts, dtype=np.float64)
    x, y = p[..., 0], p[..., 1]
    w = H[2, 0] * x + H[2, 1] * y + H[2, 2]
    return np.stack([(H[0, 0] * x + H[0, 1] * y + H[0, 2]) / w, (H[1, 0] * x + H[1, 1] * y + H[1, 2]) / w], axis=-1)


def _rot(deg: float) -> np.ndarray:
    a = math.radians(deg)
    return np.array([[math.cos(a), -math.sin(a), 0.0], [math.sin(a), math.cos(a), 0.0], [0.0, 0.0, 1.0]])


def _dark(phi_deg) -> np.ndarray:
    """True for the black/red sectors (20, 18, 13, ...) at board angle phi."""
    idx = np.floor(((90.0 - np.asarray(phi_deg) + 9.0) % 360.0) / 18.0).astype(int) % 20
    return idx % 2 == 0


def _wrap(deg):
    return (np.asarray(deg) + 180.0) % 360.0 - 180.0


def _polar(H: np.ndarray, radii, angles_deg) -> np.ndarray:
    """Image points of a board polar grid -> shape (len(angles), len(radii), 2)."""
    a = np.radians(np.asarray(angles_deg, dtype=np.float64))[:, None]
    r = np.asarray(radii, dtype=np.float64)[None, :]
    return _apply(H, np.stack([r * np.cos(a), r * np.sin(a)], axis=-1))


def _chirality(H: np.ndarray) -> float:
    """Sign of the Jacobian determinant of board -> image at the bull (-1 for a normal camera)."""
    o = _apply(H, [0.0, 0.0])
    J = (H[:2, :2] - np.outer(o, H[2, :2])) / H[2, 2]
    return -1.0 if np.linalg.det(J) < 0 else 1.0


def _cal_points(H: np.ndarray) -> np.ndarray:
    return _apply(H, np.array(g.CALIBRATION_POINTS))


class _Frame:
    """Camera frame with the precomputed images the fit needs."""

    def __init__(self, bgr: np.ndarray):
        self.h, self.w = bgr.shape[:2]
        hsv = cv2.cvtColor(cv2.GaussianBlur(bgr, (5, 5), 1.0), cv2.COLOR_BGR2HSV)
        self._hsv = cv2.split(hsv)
        self.set_masks(relaxed=False)
        lab = cv2.cvtColor(bgr.astype(np.float32) * (1.0 / 255.0), cv2.COLOR_BGR2Lab)
        self.lab = cv2.GaussianBlur(lab, (0, 0), 0.8)

    def set_masks(self, relaxed: bool) -> None:
        """Mask of the red/green ring paint (closed over the thin wires)."""
        hh, s, v = self._hsv
        vref = float(np.percentile(v[::4, ::4], 99))
        f = 0.5 if relaxed else 1.0
        v_red, v_green = max(20.0, 0.25 * vref) * f, max(15.0, 0.17 * vref) * f
        redh = ((hh >= 160) | (hh <= 10)) & (v >= v_red)
        # cream sectors can look pink: split red paint from them by saturation (Otsu) if both exist
        thr = 110.0
        sv = s[redh]
        if sv.size >= 400:
            t, _ = cv2.threshold(sv.reshape(-1, 1), 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
            lo, hi = sv[sv < t], sv[sv >= t]
            if lo.size >= 0.1 * sv.size and hi.size >= 0.1 * sv.size and float(hi.mean()) - float(lo.mean()) >= 60:
                thr = float(np.clip(t, 100, 170))
        if relaxed:
            thr = min(thr, 100.0)
        red = redh & (s >= thr)
        green = (hh >= 48) & (hh <= 100) & (s >= (55 if relaxed else 70)) & (v >= v_green)
        mask = (red | green).astype(np.uint8)
        self.mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))

    def inside(self, xy: np.ndarray, margin: float = 1.0) -> np.ndarray:
        x, y = xy[..., 0], xy[..., 1]
        ok = np.isfinite(x) & np.isfinite(y)
        return ok & (x >= margin) & (y >= margin) & (x <= self.w - 1 - margin) & (y <= self.h - 1 - margin)

    @staticmethod
    def _maps(xy: np.ndarray):
        flat = xy.reshape(-1, 2)
        n = flat.shape[0]
        cols = min(max(n, 1), 4096)
        rows = -(-n // cols)
        pad = rows * cols - n
        mx = np.concatenate([flat[:, 0], np.full(pad, -10.0)]).astype(np.float32).reshape(rows, cols)
        my = np.concatenate([flat[:, 1], np.full(pad, -10.0)]).astype(np.float32).reshape(rows, cols)
        np.nan_to_num(mx, copy=False, nan=-10.0, posinf=-10.0, neginf=-10.0)
        np.nan_to_num(my, copy=False, nan=-10.0, posinf=-10.0, neginf=-10.0)
        return mx, my, n

    def sample_mask(self, xy: np.ndarray) -> np.ndarray:
        mx, my, n = self._maps(xy)
        out = cv2.remap(self.mask, mx, my, cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        return out.reshape(-1)[:n].reshape(xy.shape[:-1]) > 0

    def sample_lab(self, xy: np.ndarray) -> np.ndarray:
        mx, my, n = self._maps(xy)
        out = cv2.remap(self.lab, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        return out.reshape(-1, 3)[:n].reshape(xy.shape[:-1] + (3,))


# --------------------------------------------------------------------------- robust homography fit
def _lm(H: np.ndarray, xy: np.ndarray, circ: np.ndarray, val: np.ndarray, c: float, iters: int = 25):
    """Robust (Cauchy) Levenberg-Marquardt fit of a board->image homography.

    Image points ``xy`` must lie on board circles (circ=True, val = radius in mm) or on board
    lines through the bull (circ=False, val = angle in degrees). Residuals are (approximately)
    image distances in px. Returns (H, residuals_px).
    """
    xy = np.asarray(xy, dtype=np.float64)
    ctr = xy.mean(axis=0)
    s = float(np.sqrt(((xy - ctr) ** 2).sum(axis=1).mean())) + 1e-9
    Ni = np.array([[1 / s, 0, -ctr[0] / s], [0, 1 / s, -ctr[1] / s], [0, 0, 1.0]])
    Sb = np.diag([0.01, 0.01, 1.0])  # board in 100 mm units
    Q = Sb @ np.linalg.inv(H) @ np.linalg.inv(Ni)  # normalised image -> board
    Q /= np.linalg.norm(Q)
    xn = np.stack([(xy[:, 0] - ctr[0]) / s, (xy[:, 1] - ctr[1]) / s, np.ones(len(xy))])
    rr = np.where(circ, val, 0.0) * 0.01
    ang = np.radians(np.where(circ, 0.0, val))
    nx, ny = -np.sin(ang), np.cos(ang)

    def evaluate(Qm, jac: bool):
        h = Qm @ xn
        X, Y = h[0] / h[2], h[1] / h[2]
        rho = np.maximum(np.hypot(X, Y), 1e-12)
        f = np.where(circ, rho - rr, X * nx + Y * ny)
        if not jac:
            return f, None, X, Y, h
        fx, fy = np.where(circ, X / rho, nx), np.where(circ, Y / rho, ny)
        k = -(fx * X + fy * Y)
        # derivative w.r.t. D in Q' = (I + D) Q, D = [[d0 d1 d2] [d3 d4 d5] [d6 d7 0]]
        J = np.stack([fx * X, fx * Y, fx, fy * X, fy * Y, fy, k * X, k * Y], axis=1)
        return f, J, X, Y, h

    # residual scale: board units -> image px along the residual direction
    f, _, X, Y, h = evaluate(Q, False)
    rho = np.maximum(np.hypot(X, Y), 1e-12)
    fx, fy = np.where(circ, X / rho, nx), np.where(circ, Y / rho, ny)
    gx = ((Q[0, 0] - X * Q[2, 0]) * fx + (Q[1, 0] - Y * Q[2, 0]) * fy) / h[2]
    gy = ((Q[0, 1] - X * Q[2, 1]) * fx + (Q[1, 1] - Y * Q[2, 1]) * fy) / h[2]
    scale = s / np.maximum(np.hypot(gx, gy), 1e-12)

    r = f * scale
    cur = float(np.log1p((r / c) ** 2).sum())
    lam = 1e-3
    eye = np.eye(3)
    for _ in range(iters):
        f, J, _, _, _ = evaluate(Q, True)
        J *= scale[:, None]
        w = 1.0 / (1.0 + (r / c) ** 2)
        A = J.T @ (J * w[:, None])
        b = J.T @ (w * r)
        A += np.eye(8) * (1e-9 * np.trace(A) + 1e-12)
        improved, step = False, 0.0
        while lam < 1e7:
            try:
                delta = np.linalg.solve(A + lam * np.diag(np.diag(A)), -b)
            except np.linalg.LinAlgError:
                lam *= 10
                continue
            D = eye.copy()
            D.flat[:8] += delta
            Qn = D @ Q
            Qn /= np.linalg.norm(Qn)
            rn = evaluate(Qn, False)[0] * scale
            cn = float(np.log1p((rn / c) ** 2).sum()) if np.all(np.isfinite(rn)) else np.inf
            if cn < cur:
                Q, r, cur, step = Qn, rn, cn, float(np.abs(delta).max())
                lam = max(lam * 0.3, 1e-6)
                improved = True
                break
            lam *= 10
        if not improved or step < 1e-7:
            break
    P = np.linalg.inv(Sb) @ Q @ Ni
    Hn = np.linalg.inv(P)
    return Hn / Hn[2, 2], r


# --------------------------------------------------------------------------- start hypotheses (full mode)
def _outer_ellipse(pts: np.ndarray):
    """Ellipse through the outer boundary of a ring (or ring pieces); (ellipse, coverage) or None."""
    if len(pts) < 30:
        return None
    try:
        e = cv2.fitEllipse(pts)
    except cv2.error:
        return None
    cover = 0.0
    for _ in range(3):
        (cx, cy), (d1, d2), ang = e
        if not (np.isfinite(d1) and np.isfinite(d2)) or min(d1, d2) < 20:
            return None
        a = math.radians(ang)
        dx, dy = pts[:, 0] - cx, pts[:, 1] - cy
        u = (dx * math.cos(a) + dy * math.sin(a)) / (d1 / 2)
        v = (-dx * math.sin(a) + dy * math.cos(a)) / (d2 / 2)
        rho = np.hypot(u, v)
        bins = ((np.arctan2(v, u) + math.pi) / (2 * math.pi) * 90).astype(int) % 90
        maxr = np.zeros(90)
        np.maximum.at(maxr, bins, rho)
        cover = float((maxr > 0).mean())
        keep = rho >= maxr[bins] * 0.97
        if keep.sum() < 30:
            return None
        try:
            e = cv2.fitEllipse(pts[keep])
        except cv2.error:
            return None
    return e, cover


def _ellipse_h(e, radius: float, chir: float) -> np.ndarray:
    """Affine board -> image map that puts the board circle ``radius`` onto ellipse ``e``."""
    (cx, cy), (d1, d2), ang = e
    a = math.radians(ang)
    R = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
    A = R @ np.diag([d1 / 2, d2 / 2]) @ np.diag([1.0, chir]) / radius
    return np.array([[A[0, 0], A[0, 1], cx], [A[1, 0], A[1, 1], cy], [0.0, 0.0, 1.0]])


def _ellipse_hypotheses(fr: _Frame) -> list:
    """Candidate double-ring ellipses: single colour blobs (a closed ring) and the union of the
    largest blobs (a ring broken up by darts, shadows or a weak colour)."""
    n, labels, stats, _ = cv2.connectedComponentsWithStats(fr.mask, connectivity=8)
    if n <= 1:
        return []
    min_area = max(150, int(0.0003 * fr.w * fr.h))
    order = np.argsort(-stats[1:, cv2.CC_STAT_AREA])[:12] + 1
    out, union = [], []

    def accept(res):
        if res is None:
            return
        e, cover = res
        (cx, cy), (d1, d2), _ = e
        if cover < 0.45 or min(d1, d2) < 40 or max(d1, d2) > 3 * max(fr.w, fr.h) or min(d1, d2) < 0.12 * max(d1, d2):
            return
        if not (-0.5 * fr.w < cx < 1.5 * fr.w and -0.5 * fr.h < cy < 1.5 * fr.h):
            return
        out.append(e)

    for rank, i in enumerate(order):
        x, y, w, h, area = stats[i]
        if area < min_area:
            break
        sub = (labels[y:y + h, x:x + w] == i).astype(np.uint8)
        cnts, _ = cv2.findContours(sub, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        if not cnts:
            continue
        pts = np.vstack(cnts).reshape(-1, 2).astype(np.float32) + np.array([x, y], np.float32)
        union.append(pts)
        if rank < 6 and max(w, h) >= 50:
            accept(_outer_ellipse(pts))
    if len(union) >= 2:
        accept(_outer_ellipse(np.vstack(union)))
    return out


# --------------------------------------------------------------------------- coarse fit on the colour mask
def _ray_grid(step_deg: float, radii: np.ndarray):
    a = np.radians(np.arange(0.0, 360.0, step_deg))
    return np.degrees(a), np.stack([radii[None, :] * np.cos(a)[:, None], radii[None, :] * np.sin(a)[:, None]], axis=-1)


# first round: whole board, 2 deg / 1 mm; later rounds: 1 deg / 0.5 mm in the bull, triple and
# double bands only (NaN columns keep runs of different bands apart)
_R0 = np.arange(0.5, 240.0, 1.0)
_R1 = np.r_[np.arange(0.25, 26.0, 0.5), np.nan, np.arange(84.25, 122.0, 0.5), np.nan, np.arange(144.25, 188.0, 0.5)]
_GRID0 = _ray_grid(2.0, _R0)
_GRID1 = _ray_grid(1.0, _R1)


def _pick(rows: np.ndarray, key: np.ndarray, valid: np.ndarray, n: int) -> np.ndarray:
    """Per row the index of the valid run with the largest key (or -1)."""
    best = np.full(n, -1)
    idx = np.nonzero(valid)[0]
    if idx.size == 0:
        return best
    order = idx[np.lexsort((key[idx], rows[idx]))]
    r = rows[order]
    last = np.r_[r[1:] != r[:-1], True]
    best[r[last]] = order[last]
    return best


def _coarse(fr: _Frame, H: np.ndarray, rounds: int = 3):
    """Fit the ring circles to the colour mask. Returns (H, coverage) with coverage = share of ring
    edges (double + triple, inner + outer, every degree) found where the fitted model expects them."""
    cover = 0.0
    for rnd in range(rounds):
        (rays, board), radii, step = (_GRID0, _R0, 1.0) if rnd == 0 else (_GRID1, _R1, 0.5)
        nr = len(rays)
        m = fr.sample_mask(_apply(H, board))
        pad = np.zeros((nr, 1), bool)
        d = np.diff(np.concatenate([pad, m, pad], axis=1).astype(np.int8), axis=1)
        rows, s0 = np.nonzero(d == 1)
        _, e0 = np.nonzero(d == -1)
        if rows.size == 0 or rows.size > 12 * nr:  # nothing, or colour noise everywhere
            return None, 0.0
        r0, r1 = radii[s0] - step / 2, radii[e0 - 1] + step / 2
        length, centre = r1 - r0, (r0 + r1) / 2
        if rnd == 0:
            # start can be far off: the double ring is the outermost run, the triple the next one in
            dbl = _pick(rows, r1, (r1 >= 115) & (r1 <= 235) & (length >= 1.5) & (length <= 35), nr)
            inner = np.full(nr, -np.inf)
            has = dbl >= 0
            inner[has] = r0[dbl[has]]
            tri = _pick(rows, r1, (r1 >= 50) & (r1 < inner[rows] - 20) & (length >= 1.0) & (length <= 30), nr)
            bull = np.full(nr, -1)
        else:
            lim = 1.0 if rnd == 1 else 0.6
            dbl = _pick(rows, -np.abs(centre - 166), (np.abs(r1 - 170) <= 14 * lim) & (np.abs(r0 - 162) <= 14 * lim) & (length >= 2), nr)
            tri = _pick(rows, -np.abs(centre - 103), (np.abs(r1 - 107) <= 12 * lim) & (np.abs(r0 - 99) <= 12 * lim) & (length >= 2), nr)
            bull = _pick(rows, -np.abs(r1 - 15.9), (r0 <= 4) & (np.abs(r1 - 15.9) <= 7 * lim), nr)
        rad, ang, tgt = [], [], []
        for sel, edges in ((dbl, ((r0, 161.5), (r1, 170.0))), (tri, ((r0, 98.5), (r1, 106.5))), (bull, ((r1, 16.3),))):
            ok = sel >= 0
            for rv, target in edges:
                rad.append(rv[sel[ok]])
                ang.append(rays[ok])
                tgt.append(np.full(int(ok.sum()), target))
        rad, ang, tgt = np.concatenate(rad), np.concatenate(ang), np.concatenate(tgt)
        if rad.size < 40 or (dbl >= 0).sum() < 0.25 * nr or (tri >= 0).sum() < 0.15 * nr:
            return None, 0.0
        a = np.radians(ang)
        xy = _apply(H, np.stack([rad * np.cos(a), rad * np.sin(a)], axis=-1))
        H, res = _lm(H, xy, np.ones(len(tgt), bool), tgt, c=6.0 if rnd == 0 else 2.5, iters=15)
        cover = int(((tgt >= 90) & (np.abs(res) < 2.5)).sum()) / (4.0 * nr)
    return H, cover


# --------------------------------------------------------------------------- rotation
_PHI = np.arange(0.0, 360.0, 0.5)
_PHASE_MODEL = np.where(_dark(_PHI + 0.25), 1.0, -1.0)


def _phase(fr: _Frame, H: np.ndarray):
    """Rotation alpha (deg, modulo 36) so that H @ _rot(alpha) has the sector colours right, and the
    normalised correlation of the colour pattern (0..1)."""
    ring = _polar(H, [164.0, 166.0, 168.0, 101.0, 103.0, 105.0], _PHI + 0.25)
    single = _polar(H, [35.0, 55.0, 75.0, 90.0, 115.0, 130.0, 145.0, 155.0], _PHI + 0.25)

    def signal(xy, ch):
        v = fr.sample_lab(xy)[..., ch]
        ok = fr.inside(xy)
        cnt = ok.sum(axis=1)
        sig = np.where(cnt > 0, (v * ok).sum(axis=1) / np.maximum(cnt, 1), np.nan)
        good = np.isfinite(sig)
        if good.sum() < 20:
            return np.zeros(len(sig))
        z = sig - np.median(sig[good])
        z /= z[good].std() + 1e-6
        return np.where(good, z, 0.0)

    s = signal(ring, 1) - signal(single, 0)  # red rings (a*) and dark singles (L*) go together
    m = _PHASE_MODEL
    corr = np.real(np.fft.ifft(np.fft.fft(s) * np.conj(np.fft.fft(m))))
    k = int(np.argmax(corr))
    cl, cc, cr = corr[k - 1], corr[k], corr[(k + 1) % len(corr)]
    den = cl - 2 * cc + cr
    delta = 0.5 * (cl - cr) / den if den < 0 else 0.0
    alpha = ((k + float(np.clip(delta, -0.5, 0.5))) * 0.5) % 36.0
    strength = float(cc / (np.linalg.norm(s) * np.linalg.norm(m) + 1e-9))
    return alpha, strength


# --------------------------------------------------------------------------- fine edge model
# Circle edges: nominal radius (geometry.py), class inside, class outside, angular sample step (deg).
_CIRCLES = (
    (g.DOUBLE_OUTER, "ring", "surr", 1.0),
    (g.DOUBLE_INNER, "single", "ring", 1.0),
    (g.TRIPLE_OUTER, "ring", "single", 1.5),
    (g.TRIPLE_INNER, "single", "ring", 1.5),
    (g.BULL, "bullg", "single", 4.0),
    (g.DOUBLE_BULL, "bullr", "bullg", 10.0),
)
# Allowed deviation (mm) of the visible edge from the nominal radius. On real boards the nominal
# values are wire edges, the colour edge seen by the camera is up to a wire width (~1.5 mm) away.
_RADIUS_RANGE = ((-1.2, 1.2), (-2.5, 1.0), (-2.0, 1.0), (-2.5, 1.0), (-1.0, 2.0), (-1.5, 2.0))


def _build_model():
    X, D, cin, cout, circ, val, grp = [], [], [], [], [], [], []

    def add(x, d, ci, co, is_c, v, gr):
        X.append(x)
        D.append(d)
        cin.append(ci)
        cout.append(co)
        circ.append(np.full(len(x), is_c))
        val.append(np.full(len(x), v, dtype=np.float64))
        grp.append(np.broadcast_to(gr, (len(x),)).astype(int))

    # ring circles; every circle is split into two edge groups (dark / light sectors) whose radius
    # is estimated from the image: the visible colour edge sits on one or the other side of the wire.
    for ci_, (r, cin_k, cout_k, step) in enumerate(_CIRCLES):
        phi = np.arange(step / 2, 360.0, step)
        if r > 10:
            phi = phi[np.abs(_wrap(phi[:, None] - _WIRES[None, :])).min(axis=1) > (3.0 if r < 20 else 2.0)]
        dark = _dark(phi)
        cls = {
            "ring": np.where(dark, _RED, _GREEN), "single": np.where(dark, _BLACK, _CREAM),
            "surr": np.full(len(phi), _SURR), "bullg": np.full(len(phi), _BULL_G), "bullr": np.full(len(phi), _BULL_R),
        }
        a = np.radians(phi)
        u = np.stack([np.cos(a), np.sin(a)], axis=-1)
        add(u * r, u, cls[cin_k], cls[cout_k], True, r, 2 * ci_ + dark.astype(int))
    # sector wires: search across the wire (counter-clockwise)
    radii = np.r_[np.arange(30.0, 95.0, 6.0), np.arange(112.0, 158.0, 5.0), 103.0, 166.0]
    is_ring = (np.abs(radii - 103) < 4) | (np.abs(radii - 166) < 4)
    for w in _WIRES:
        a = math.radians(w)
        u = np.array([math.cos(a), math.sin(a)])
        t = np.array([-math.sin(a), math.cos(a)])
        dark_cw, dark_ccw = bool(_dark(w - 9.0)), bool(_dark(w + 9.0))
        ci = np.where(is_ring, _RED if dark_cw else _GREEN, _BLACK if dark_cw else _CREAM)
        co = np.where(is_ring, _RED if dark_ccw else _GREEN, _BLACK if dark_ccw else _CREAM)
        add(radii[:, None] * u[None, :], np.tile(t, (len(radii), 1)), ci, co, False, w, -1)
    model = {
        "X": np.vstack(X), "D": np.vstack(D), "cin": np.concatenate(cin), "cout": np.concatenate(cout),
        "circ": np.concatenate(circ), "val": np.concatenate(val), "grp": np.concatenate(grp),
    }
    # sample points for the class colours (centres of the areas)
    sec = 90.0 - 18.0 * np.arange(20)
    offs = np.array([-5.0, -2.5, 0.0, 2.5, 5.0])

    def area_pts(dark: bool, radii_):
        ph = (sec[(np.arange(20) % 2 == 0) == dark][:, None] + offs[None, :]).ravel()
        a = np.radians(ph)[:, None]
        r = np.asarray(radii_)[None, :]
        return np.stack([(r * np.cos(a)).ravel(), (r * np.sin(a)).ravel()], axis=-1)

    a = np.radians(np.arange(0.0, 360.0, 5.0))[:, None]
    rs = np.array([[174.0, 177.0]])
    surr = np.stack([(rs * np.cos(a)).ravel(), (rs * np.sin(a)).ravel()], axis=-1)
    a = np.radians(np.arange(0.0, 360.0, 30.0))
    bullg = np.stack([11.0 * np.cos(a), 11.0 * np.sin(a)], axis=-1)
    bullr = np.vstack([[0.0, 0.0], np.stack([2.5 * np.cos(a[::3]), 2.5 * np.sin(a[::3])], axis=-1)])
    model["means"] = [
        surr,
        area_pts(True, [45.0, 65.0, 85.0, 120.0, 135.0, 150.0]),
        area_pts(False, [45.0, 65.0, 85.0, 120.0, 135.0, 150.0]),
        area_pts(True, [165.0, 166.5, 102.0, 104.0]),
        area_pts(False, [165.0, 166.5, 102.0, 104.0]),
        bullg,
        bullr,
    ]
    return model


_MODEL = _build_model()


def _class_means(fr: _Frame, H: np.ndarray) -> np.ndarray:
    mu = np.full((7, 3), np.nan)
    for k, pts in enumerate(_MODEL["means"]):
        xy = _apply(H, pts)
        ok = fr.inside(xy)
        if ok.sum() >= 3:
            mu[k] = np.median(fr.sample_lab(xy[ok]), axis=0)
    return mu


def _search(fr: _Frame, H: np.ndarray, mu: np.ndarray, T: float, target: np.ndarray):
    """Find every model edge within +-T px of its projection. Returns (points, found, visible).

    The image is sampled along the projected edge normal and projected onto the expected colour
    change (class means of this image), giving a profile that goes 0 -> 1 across a matching edge.
    The edge is the steepest rise (sub-pixel parabola), which must be part of a real step.
    """
    M = _MODEL
    X = np.where(M["circ"][:, None], M["D"] * target[:, None], M["X"])
    x0 = _apply(H, X)
    d = _apply(H, X + 0.25 * M["D"]) - x0
    d /= np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-12)
    ts = np.arange(-T, T + 1e-9, 0.5)
    line = x0[:, None, :] + ts[None, :, None] * d[:, None, :]
    visible = fr.inside(line[:, 0], 2) & fr.inside(line[:, -1], 2)
    F = fr.sample_lab(line)
    m_in, m_out = mu[M["cin"]], mu[M["cout"]]
    dm = m_out - m_in
    n2 = (dm ** 2).sum(axis=1)
    contrast = np.isfinite(n2) & (n2 >= 64.0)
    e = np.where(contrast[:, None], dm / np.where(contrast, n2, 1.0)[:, None], 0.0)
    p = ((F - np.nan_to_num(m_in)[:, None, :]) * e[:, None, :]).sum(axis=-1)
    gr = p[:, 2:] - p[:, :-2]
    tc = ts[1:-1]
    k = np.argmax(gr * (1.0 - 0.3 * (tc / T) ** 2)[None, :], axis=1)
    i = np.arange(len(k))
    kl, kr = np.maximum(k - 1, 0), np.minimum(k + 1, len(tc) - 1)
    gk, gl, grr = gr[i, k], gr[i, kl], gr[i, kr]
    den = gl - 2 * gk + grr
    delta = np.where(den < 0, 0.5 * (gl - grr) / np.where(den < 0, den, -1.0), 0.0)
    t = tc[k] + np.clip(delta, -0.5, 0.5) * 0.5
    pa = p[i, np.minimum(k + 1 + 4, len(ts) - 1)]
    pb = p[i, np.maximum(k + 1 - 4, 0)]
    found = visible & contrast & (k > 0) & (k < len(tc) - 1) & (gk >= 0.12) & (pa - pb >= 0.4)
    return x0 + t[:, None] * d, found, visible


def _update_radii(H: np.ndarray, pts: np.ndarray, found: np.ndarray, target: np.ndarray) -> np.ndarray:
    """Re-estimate the visible radius of every circle edge group; the outer double edge keeps the scale."""
    M = _MODEL
    B = _apply(np.linalg.inv(H), pts)
    rr = np.hypot(B[:, 0], B[:, 1])
    med = {}
    for gid in range(2 * len(_CIRCLES)):
        s = found & (M["grp"] == gid)
        if s.sum() >= 8:
            med[gid] = float(np.median(rr[s]))
    anchor = [med[k] for k in (0, 1) if k in med]
    if not anchor:
        return target
    sc = g.DOUBLE_OUTER / float(np.mean(anchor))
    new = target.copy()
    for gid, m in med.items():
        nominal = _CIRCLES[gid // 2][0]
        lo, hi = _RADIUS_RANGE[gid // 2]
        new[M["grp"] == gid] = float(np.clip(m * sc, nominal + lo, nominal + hi))
    return new


def _fine(fr: _Frame, H: np.ndarray):
    M = _MODEL
    target = M["val"].copy()
    for T, c, upd in ((6.0, 2.5, False), (4.0, 2.0, True), (3.0, 1.5, True), (2.5, 1.5, True), (2.0, 1.2, True), (2.0, 1.2, True)):
        mu = _class_means(fr, H)
        pts, found, _ = _search(fr, H, mu, T, target)
        if found.sum() < 80:
            return None
        if upd:
            target = _update_radii(H, pts, found, target)
        H, _ = _lm(H, pts[found], M["circ"][found], target[found], c=c, iters=20)
    stats = _evaluate(fr, H, target)
    return H, stats


def _evaluate(fr: _Frame, H: np.ndarray, target: np.ndarray) -> dict:
    """Fit quality: which visible model edges are found (+-3 px) and how many of them sit within
    1.5 px of the fitted model; plus the sector colour check."""
    M = _MODEL
    mu = _class_means(fr, H)
    pts, found, visible = _search(fr, H, mu, 3.0, target)
    stats = {"visible": float(visible.mean()), "found": 0.0, "edge": 0.0, "precision": 0.0, "rms": 99.0}
    if found.sum() >= 30 and visible.sum() > 0:
        _, res = _lm(H, pts[found], M["circ"][found], target[found], c=1.2, iters=0)
        inl = np.abs(res) < 1.5
        stats["found"] = float(found.sum() / visible.sum())
        stats["edge"] = float(inl.sum() / visible.sum())
        stats["precision"] = float(inl.mean())
        stats["rms"] = float(np.sqrt(np.mean(res[inl] ** 2))) if inl.any() else 99.0
    stats["sectors"] = _sector_check(fr, H)
    stats["radii"] = [round(float(target[M["grp"] == k][0]), 2) for k in range(2 * len(_CIRCLES))]
    return stats


def _sector_check(fr: _Frame, H: np.ndarray) -> float:
    """Share of neighbouring sector pairs whose ring colour / single brightness differ the right way."""
    sec = 90.0 - 18.0 * np.arange(20)
    offs = np.array([-4.0, -2.0, 0.0, 2.0, 4.0])
    ph = (sec[:, None] + offs[None, :]).ravel()

    def feat(radii, ch):
        xy = _polar(H, radii, ph)
        ok = fr.inside(xy).reshape(20, -1)
        v = np.where(ok, fr.sample_lab(xy)[..., ch].reshape(20, -1), np.nan)
        with np.errstate(all="ignore"):
            return np.where(ok.sum(axis=1) >= 3, np.nanmedian(v, axis=1), np.nan)

    a_d = feat([164.5, 166.0, 167.5], 1)
    a_t = feat([101.5, 103.0, 104.5], 1)
    lum = feat([50.0, 70.0, 125.0, 145.0], 0)
    sign = np.where(np.arange(20) % 2 == 0, 1.0, -1.0)
    checks = []
    for f, thr, sg in ((a_d, 12.0, 1.0), (a_t, 12.0, 1.0), (lum, 8.0, -1.0)):
        diff = (f - np.roll(f, -1)) * sign * sg
        checks.append(diff[np.isfinite(diff)] >= thr)
    allc = np.concatenate(checks)
    return float(allc.mean()) if allc.size >= 10 else 0.0


def _score(st: dict) -> float:
    """0..1: mostly how many of the detected edges agree with the fit to 1.5 px (blur-independent);
    lowered if less than ~45 % of the model edges are detectable or the sector colours disagree."""
    if st["visible"] < 0.3:
        return 0.0
    precision = min(1.0, max(0.0, (st["precision"] - 0.6) / 0.35))
    found = min(1.0, st["found"] / 0.45)
    sectors = min(1.0, st["sectors"] / 0.85)
    return float(precision * found * sectors)


# --------------------------------------------------------------------------- pipeline
def _coarse_stage(fr: _Frame, H0: np.ndarray):
    """Coarse fit + rotation modulo 36 deg; (H, quality) or None."""
    H, cover = _coarse(fr, H0)
    if H is None or cover < 0.2:
        return None
    alpha, strength = _phase(fr, H)
    if strength < 0.25:
        return None
    return H @ _rot(alpha), cover * strength


def _fine_stage(fr: _Frame, H: np.ndarray, quality: float):
    res = _fine(fr, H)
    if res is None:
        return None
    H, st = res
    st["coarse"] = quality
    st["score"] = _score(st)
    return H, st


def _same_board(Ha: np.ndarray, Hb: np.ndarray, tol: float = 4.0) -> bool:
    ring = g.circle_points(g.DOUBLE_OUTER, 36)
    pa, pb = _apply(Ha, ring), _apply(Hb, ring)
    d = np.linalg.norm(pa[:, None, :] - pb[None, :, :], axis=2).min(axis=1)
    centre = np.linalg.norm(_apply(Ha, [0.0, 0.0]) - _apply(Hb, [0.0, 0.0]))
    return float(d.mean()) < tol and float(centre) < tol


def _detect(fr: _Frame, chir: float, max_starts: int = 8):
    """Find the board without prior knowledge; (H, stats) of the best fit or None."""
    hyps = []
    for e in _ellipse_hypotheses(fr):
        (cx, cy), (d1, d2), _ = e
        if not any(abs(cx - f[0][0]) < 6 and abs(cy - f[0][1]) < 6 and abs(d1 - f[1][0]) < 0.05 * d1 and abs(d2 - f[1][1]) < 0.05 * d2 for f in hyps):
            hyps.append(e)
    coarse, tried = [], 0
    for radius in (g.DOUBLE_OUTER, g.TRIPLE_OUTER):  # the largest ring could also be the triple
        if coarse and max(q for _, q in coarse) >= 0.35:
            break
        for e in hyps:
            if tried >= max_starts:
                break
            tried += 1
            try:
                res = _coarse_stage(fr, _ellipse_h(e, radius, chir))
            except _ERRORS:
                res = None
            if res is not None and not any(_same_board(res[0], c[0]) for c in coarse):
                coarse.append(res)
    coarse.sort(key=lambda c: -c[1])
    best = None
    for H, q in coarse[:2]:
        try:
            res = _fine_stage(fr, H, q)
        except _ERRORS:
            res = None
        if res is not None and (best is None or res[1]["score"] > best[1]["score"]):
            best = res
        if best is not None and best[1]["score"] >= 0.8:
            break
    return best


def _candidates(H: np.ndarray) -> list[np.ndarray]:
    return [H @ _rot(36.0 * k) for k in range(10)]


def _guess_up(cands: list[np.ndarray]) -> int:
    """Best guess without hint: the rotation that puts the 20 towards the top of the image."""
    return int(np.argmin([float(_apply(Hk, [0.0, 140.0])[1] - _apply(Hk, [0.0, 0.0])[1]) for Hk in cands]))


def _hint_angle(H: np.ndarray, hint_px) -> tuple[float, float]:
    b = _apply(np.linalg.inv(H), np.asarray(hint_px, dtype=np.float64))
    return math.degrees(math.atan2(b[1], b[0])), math.hypot(b[0], b[1])


def _prior_rotation(H: np.ndarray, prior_px: np.ndarray) -> float:
    """Mean rotation (deg) of the prior's outer points against H (board frame)."""
    b = _apply(np.linalg.inv(H), prior_px[:4])
    d = np.radians(_wrap(np.degrees(np.arctan2(b[:, 1], b[:, 0])) - _CAL_ANGLES))
    return math.degrees(math.atan2(np.sin(d).mean(), np.cos(d).mean()))


def _result(ok, H, w, h, score, mode, needs_hint, message):
    pts = None
    if H is not None:
        # stored points use edge coordinates like the app (pixel centre i -> (i + 0.5) / width)
        pts = [[float((x + 0.5) / w), float((y + 0.5) / h)] for x, y in _cal_points(H)]
    return {"ok": bool(ok), "points": pts, "score": round(float(score), 3), "mode": mode, "needsHint": bool(needs_hint), "message": message}


def auto_calibrate(
    frame_bgr: np.ndarray, prior: list[tuple[float, float]] | None = None, hint20: tuple[float, float] | None = None
) -> dict:
    """Calibrate one camera from a single frame.

    prior:  five normalised points (old or roughly placed calibration) -> snap them to the board
            ("refine"); also gives the rotation if the board has to be searched from scratch.
    hint20: normalised image point anywhere inside the 20 sector -> fixes the rotation ("full").
    Returns {"ok", "points" (5 normalised [x, y] or None), "score" (0..1), "mode" ("refine"|"full"),
             "needsHint", "message" (German, for the user)}.
    """
    mode = "refine" if prior else "full"
    if frame_bgr is None or not hasattr(frame_bgr, "ndim") or frame_bgr.ndim not in (2, 3) or frame_bgr.size == 0:
        return _result(False, None, 1, 1, 0.0, mode, False, "Kein Kamerabild.")
    if frame_bgr.ndim == 2:
        frame_bgr = cv2.cvtColor(np.ascontiguousarray(frame_bgr, dtype=np.uint8), cv2.COLOR_GRAY2BGR)
    elif frame_bgr.shape[2] == 4:
        frame_bgr = cv2.cvtColor(np.ascontiguousarray(frame_bgr, dtype=np.uint8), cv2.COLOR_BGRA2BGR)
    frame_bgr = np.ascontiguousarray(frame_bgr, dtype=np.uint8)
    h, w = frame_bgr.shape[:2]
    if min(h, w) < 64:
        return _result(False, None, w, h, 0.0, mode, False, "Kein Kamerabild.")
    fr = _Frame(frame_bgr)

    prior_H, prior_px, prior_mirrored = None, None, False
    if prior is not None:
        try:
            # edge coordinates of the app -> pixel-centre convention of OpenCV
            pr = [(float(p[0]) - 0.5 / w, float(p[1]) - 0.5 / h) for p in prior]
            if len(pr) == 5 and all(math.isfinite(v) for p in pr for v in p):
                prior_H = g.board_to_image_homography(pr, w, h)
                prior_px = np.array([(x * w, y * h) for x, y in pr])
        except (TypeError, ValueError, IndexError, cv2.error):
            prior_H = None
        if prior_H is not None and not np.all(np.isfinite(prior_H)):
            prior_H = None
        if prior_H is not None and g.calibration_mirrored(pr):
            prior_H, prior_px, prior_mirrored = None, None, True
    hint_px = None
    if hint20 is not None:
        try:
            hint_px = (float(hint20[0]) * w - 0.5, float(hint20[1]) * h - 0.5)
            if not all(math.isfinite(v) for v in hint_px):
                hint_px = None
        except (TypeError, ValueError, IndexError):
            hint_px = None

    def finish(H, st, mode_):
        score = st["score"]
        cands = _candidates(H)
        k, needs, msg = _guess_up(cands), True, "Board gefunden – tippe einmal auf die 20, damit die Ausrichtung stimmt."
        if prior_mirrored:
            msg = "Board gefunden. Die alte Kalibrierung war spiegelverkehrt (Punkte vertauscht) – tippe einmal auf die 20."
        if hint_px is not None and _hint_angle(H, hint_px)[1] >= _MIN_HINT_R:
            k = int(np.argmin([abs(float(_wrap(_hint_angle(Hk, hint_px)[0] - 90.0))) for Hk in cands]))
            needs = False
        elif prior_px is not None:
            rots = [_prior_rotation(Hk, prior_px) for Hk in cands]
            k = int(np.argmin(np.abs(rots)))
            needs = abs(rots[k]) > _PRIOR_MAX_ROT
            msg = "Board gefunden, aber die Ausrichtung ist unklar – tippe einmal auf die 20."
        elif hint_px is not None:
            msg = "Bitte in das Feld der 20 tippen, nicht auf das Bull."
        if score < OK_SCORE:
            return _result(False, cands[k] if score >= _SHOW_SCORE else None, w, h, score, mode_, False,
                           "Board nur unsicher erkannt – bitte die Punkte von Hand prüfen.")
        if needs:
            return _result(False, cands[k], w, h, score, mode_, True, msg)
        verb = "angepasst" if mode_ == "refine" else "erkannt"
        return _result(True, cands[k], w, h, score, mode_, False, f"Board {verb} ({round(score * 100)} % Übereinstimmung).")

    best, best_mode = None, mode
    if prior_H is not None:
        try:
            res = _coarse_stage(fr, prior_H)
            res = None if res is None else _fine_stage(fr, *res)
        except _ERRORS:
            res = None
        if res is not None and res[1]["score"] >= OK_SCORE:
            return finish(res[0], res[1], "refine")
        best = res

    chir = _chirality(prior_H) if prior_H is not None else -1.0
    for relaxed in (False, True):
        if relaxed:
            if best is not None and best[1]["score"] >= _SHOW_SCORE:
                break
            fr.set_masks(relaxed=True)  # e.g. a dim board: weaker colours
        res = _detect(fr, chir, max_starts=4 if relaxed else 8)
        if res is not None and (best is None or res[1]["score"] > best[1]["score"]):
            best, best_mode = res, "full"
        if best is not None and best[1]["score"] >= OK_SCORE:
            break
    if best is None or best[1]["score"] < 0.2:
        return _result(False, None, w, h, 0.0 if best is None else best[1]["score"], best_mode, False,
                       "Kein Dartboard gefunden – ist das Board gut beleuchtet und ganz im Bild?")
    return finish(best[0], best[1], best_mode)
