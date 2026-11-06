"""USB camera discovery (Linux/V4L2) and capture threads."""
from __future__ import annotations

import glob
import logging
import os
import re
import threading
import time
from dataclasses import dataclass

import cv2
import numpy as np

log = logging.getLogger(__name__)


@dataclass
class CameraDesc:
    device: str
    cam_id: str  # stable id (USB port path) used to store the calibration
    name: str


def _read(path: str, default: str = "") -> str:
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return default


def discover(explicit: list[str] | None = None) -> list[CameraDesc]:
    """Find USB capture devices. Ignores the Pi's internal codec/ISP nodes and metadata nodes."""
    if explicit:
        return [CameraDesc(dev, _stable_id(dev), os.path.basename(dev)) for dev in explicit]
    found: list[CameraDesc] = []
    nodes = sorted(glob.glob("/sys/class/video4linux/video*"), key=lambda p: int(re.sub(r"\D", "", p) or 0))
    for node in nodes:
        if _read(os.path.join(node, "index"), "0") != "0":
            continue  # second node of a UVC camera = metadata
        devpath = os.path.realpath(os.path.join(node, "device"))
        if "/usb" not in devpath:
            continue  # rpi-hevc-dec, pispbe, … are not cameras
        dev = "/dev/" + os.path.basename(node)
        found.append(CameraDesc(dev, _stable_id(dev), _read(os.path.join(node, "name"), dev)))
    # stable order = USB port order, so camera numbers don't change between reboots
    found.sort(key=lambda c: c.cam_id)
    return found


def _stable_id(dev: str) -> str:
    real = os.path.realpath(dev)
    for link in glob.glob("/dev/v4l/by-path/*"):
        if os.path.realpath(link) == real and "video-index0" in link:
            return os.path.basename(link).replace("-video-index0", "")
    return os.path.basename(dev)


class CameraStream(threading.Thread):
    """Grabs frames continuously and keeps only the latest one."""

    def __init__(self, index: int, desc: CameraDesc, width: int, height: int, fps: int):
        super().__init__(daemon=True, name=f"cam-{index}")
        self.index = index
        self.device = desc.device
        self.cam_id = desc.cam_id
        self.name = desc.name
        self.req = (width, height, fps)
        self.width, self.height = width, height
        self.fps = fps
        self.ok = False
        self.measured_fps = 0.0
        self._frame: np.ndarray | None = None
        self._frame_id = 0
        self._lock = threading.Lock()
        self._running = True

    def _open(self) -> cv2.VideoCapture | None:
        cap = cv2.VideoCapture(self.device, cv2.CAP_V4L2)
        if not cap.isOpened():
            return None
        w, h, fps = self.req
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))  # needed for 3 cams on USB bandwidth
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, w)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, h)
        cap.set(cv2.CAP_PROP_FPS, fps)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        self.width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or w
        self.height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or h
        log.info("camera %d (%s) opened at %dx%d", self.index, self.device, self.width, self.height)
        return cap

    def run(self) -> None:
        cap = None
        failures = 0
        count, last = 0, time.time()
        while self._running:
            if cap is None:
                cap = self._open()
                if cap is None:
                    self.ok = False
                    time.sleep(2)
                    continue
            ok, frame = cap.read()
            if not ok or frame is None:
                failures += 1
                if failures > 20:
                    log.warning("camera %d lost – reopening", self.index)
                    cap.release()
                    cap = None
                    failures = 0
                time.sleep(0.05)
                continue
            failures = 0
            self.ok = True
            with self._lock:
                self._frame = frame
                self._frame_id += 1
            count += 1
            now = time.time()
            if now - last >= 1:
                self.measured_fps = count / (now - last)
                count, last = 0, now
        if cap is not None:
            cap.release()

    def latest(self) -> tuple[int, np.ndarray | None]:
        with self._lock:
            return self._frame_id, self._frame

    def stop(self) -> None:
        self._running = False


class CameraManager:
    def __init__(self, source: str, explicit: list[str], sim_world=None):
        self.source = source
        self.explicit = explicit
        self.sim_world = sim_world
        self.streams: list = []

    def start(self, width: int, height: int, fps: int) -> None:
        self.stop()
        if self.source == "sim":
            from .sim import SimCamera

            self.streams = [SimCamera(self.sim_world, i, fps) for i in range(len(self.sim_world.models))]
        else:
            descs = discover(self.explicit)
            if not descs:
                log.warning("no USB cameras found")
            self.streams = [CameraStream(i, d, width, height, fps) for i, d in enumerate(descs)]
        for s in self.streams:
            s.start()

    def stop(self) -> None:
        for s in self.streams:
            s.stop()
        for s in self.streams:
            s.join(timeout=2)
        self.streams = []

    def frames(self) -> dict[int, np.ndarray]:
        out = {}
        for s in self.streams:
            _, frame = s.latest()
            if frame is not None:
                out[s.index] = frame
        return out

    def by_index(self, index: int):
        for s in self.streams:
            if s.index == index:
                return s
        return None
