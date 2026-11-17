"""Frontal view: a point of the board must land where the virtual board in the app draws it."""
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from autodarter_board.geometry import BOARD_VIEW, apply_h, board_to_image_homography, front_view  # noqa: E402
from autodarter_board.sim import SimWorld  # noqa: E402


def test_front_view_maps_board_points_to_app_coordinates():
    world = SimWorld(cameras=3, width=1280, height=720)
    size = 400
    for cam in range(3):
        pts = world.calibration(cam)
        H = board_to_image_homography([tuple(p) for p in pts], 1280, 720)
        for bx, by in [(0.0, 0.0), (0.0, 170.0), (-120.0, -60.0), (90.0, 40.0)]:
            u, v = apply_h(H, [(bx, by)])[0]
            img = np.zeros((720, 1280, 3), np.uint8)
            cv2.circle(img, (int(round(u)), int(round(v))), 3, (255, 255, 255), -1)
            out = front_view(img, H, size)
            gray = cv2.cvtColor(out, cv2.COLOR_BGR2GRAY)
            ys, xs = np.nonzero(gray > 60)
            assert len(xs), f"cam {cam}: point {bx},{by} not visible"
            cx, cy = xs.mean(), ys.mean()
            # app: x_svg = (bx + VIEW) / (2 VIEW) * size, y_svg = (VIEW - by) / (2 VIEW) * size
            ex = (bx + BOARD_VIEW) / (2 * BOARD_VIEW) * size
            ey = (BOARD_VIEW - by) / (2 * BOARD_VIEW) * size
            assert abs(cx - ex) < 2.5 and abs(cy - ey) < 2.5, (cam, bx, by, cx, cy, ex, ey)
