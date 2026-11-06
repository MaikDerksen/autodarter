"""Board client: wires cameras, detector, server connection and the local status page together."""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import threading
import time

import aiohttp
import cv2

from . import __version__
from .cameras import CameraManager
from .config import CAMERA_SOURCE, CAMERAS, SIM_AUTOCALIBRATE, Store
from .detector import Detector
from .geometry import segment_label

log = logging.getLogger("autodarter")


def encode_jpeg(frame, max_width: int | None = None, quality: int = 75) -> tuple[str, int, int]:
    h, w = frame.shape[:2]
    if max_width and w > max_width:
        frame = cv2.resize(frame, (max_width, int(h * max_width / w)), interpolation=cv2.INTER_AREA)
        h, w = frame.shape[:2]
    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise RuntimeError("jpeg encoding failed")
    return base64.b64encode(buf.tobytes()).decode("ascii"), w, h


class BoardApp:
    def __init__(self) -> None:
        self.store = Store()
        self.sim = None
        if CAMERA_SOURCE == "sim":
            from .sim import SimWorld

            w, h = self.store.settings.resolution
            self.sim = SimWorld(cameras=3, width=w, height=h)
        self.cameras = CameraManager(CAMERA_SOURCE, CAMERAS, self.sim)
        self.detector = Detector(self.store.settings)
        self.loop: asyncio.AbstractEventLoop | None = None
        self.queue: asyncio.Queue | None = None
        self.ws: aiohttp.ClientWebSocketResponse | None = None
        self.connected = False
        self.claimed = False
        self.pairing_code: str | None = None
        self.board_name: str | None = None
        self.server_error: str | None = None
        self.stream = {"enabled": False, "fps": 4, "maxWidth": 640}
        self.last_dart: dict | None = None
        self.proc_fps = 0.0
        self.running = True
        self._reconnect = asyncio.Event()
        self._status_sig = None
        self._cam_lock = threading.Lock()

    # ------------------------------------------------------------------ cameras & calibration
    def start_cameras(self) -> None:
        with self._cam_lock:
            w, h = self.store.settings.resolution
            self.cameras.start(w, h, self.store.settings.fps)
            if self.sim is not None and SIM_AUTOCALIBRATE:
                for s in self.cameras.streams:
                    self.store.calibration.setdefault(s.cam_id, {"points": [list(p) for p in self.sim.calibration(s.index)]})
            self.apply_calibration()
            self.detector.reset()

    def apply_calibration(self) -> None:
        for idx in list(self.detector.cams):
            self.detector.set_calibration(idx, None)
        for s in self.cameras.streams:
            cal = self.store.calibration.get(s.cam_id)
            if cal and len(cal.get("points", [])) == 5:
                self.detector.set_calibration(s.index, [tuple(p) for p in cal["points"]])

    def calibration_by_index(self) -> dict:
        out = {}
        for s in self.cameras.streams:
            cal = self.store.calibration.get(s.cam_id)
            out[str(s.index)] = {"points": [{"x": p[0], "y": p[1]} for p in cal["points"]]} if cal else None
        return out

    def status(self) -> dict:
        cams = []
        for s in self.cameras.streams:
            cams.append(
                {
                    "index": s.index,
                    "id": s.cam_id,
                    "name": s.name,
                    "device": s.device,
                    "width": s.width,
                    "height": s.height,
                    "fps": round(s.measured_fps, 1),
                    "ok": bool(s.ok),
                    "calibrated": s.index in self.detector.cams,
                }
            )
        state = self.detector.public_state()
        message = None
        if not cams:
            state, message = "error", "Keine USB-Kameras gefunden."
        elif not any(c["ok"] for c in cams):
            state, message = "starting", "Warte auf Kamerabilder …"
        elif state == "calibration_needed":
            message = "Bitte mindestens eine Kamera kalibrieren."
        elif not all(c["calibrated"] for c in cams):
            message = "Nicht alle Kameras sind kalibriert – die Genauigkeit ist reduziert."
        if self.sim is not None:
            message = (message + " " if message else "") + "Simulationsmodus."
        return {
            "state": state,
            "detecting": self.detector.detecting,
            "darts": self.detector.darts,
            "fps": round(self.proc_fps, 1),
            "cameras": cams,
            "message": message,
            "version": __version__,
        }

    # ------------------------------------------------------------------ detection thread
    def detection_thread(self) -> None:
        count, last = 0, time.time()
        while self.running:
            start = time.time()
            try:
                with self._cam_lock:
                    frames = self.cameras.frames()
                events = self.detector.process(frames) if frames else []
            except Exception:  # never let the loop die
                log.exception("detection step failed")
                events = []
            for ev in events:
                if self.loop and self.queue:
                    self.loop.call_soon_threadsafe(self.queue.put_nowait, ev)
            count += 1
            if time.time() - last >= 2:
                self.proc_fps = count / (time.time() - last)
                count, last = 0, time.time()
            period = 1.0 / max(1, self.store.settings.fps)
            time.sleep(max(0.0, period - (time.time() - start)))

    # ------------------------------------------------------------------ server connection
    async def send(self, msg: dict) -> None:
        ws = self.ws
        if ws is None or ws.closed:
            return
        try:
            await ws.send_str(json.dumps(msg))
        except Exception as err:  # connection dropped
            log.debug("send failed: %s", err)

    async def send_status(self, force: bool = False) -> None:
        st = self.status()
        sig = json.dumps({k: v for k, v in st.items() if k != "fps"} | {"cams": [(c["ok"], c["calibrated"]) for c in st["cameras"]]}, default=str)
        if force or sig != self._status_sig:
            self._status_sig = sig
            await self.send({"type": "status", "status": st})

    def ws_url(self) -> str | None:
        url = self.store.server_url
        if not url:
            return None
        if url.startswith("http"):
            url = "ws" + url[4:]
        elif not url.startswith("ws"):
            url = "ws://" + url
        return url.rstrip("/") + "/ws/board"

    async def server_loop(self) -> None:
        backoff = 1
        async with aiohttp.ClientSession() as session:
            while self.running:
                url = self.ws_url()
                if not url:
                    self.server_error = "Keine Server-Adresse konfiguriert (AUTODARTER_SERVER oder Statusseite)."
                    await self._wait_reconnect(5)
                    continue
                try:
                    async with session.ws_connect(url, heartbeat=20, max_msg_size=32 * 1024 * 1024) as ws:
                        self.ws = ws
                        self.connected = True
                        self.server_error = None
                        backoff = 1
                        log.info("connected to %s", url)
                        await ws.send_str(
                            json.dumps(
                                {
                                    "type": "hello",
                                    "boardId": self.store.board_id,
                                    "secret": self.store.secret,
                                    "version": __version__,
                                    "status": self.status(),
                                    "calibration": self.calibration_by_index(),
                                    "settings": self.store.settings.to_dict(),
                                }
                            )
                        )
                        reconnect_task = asyncio.create_task(self._reconnect.wait())
                        try:
                            async for msg in ws:
                                if msg.type == aiohttp.WSMsgType.TEXT:
                                    try:
                                        await self.handle(json.loads(msg.data))
                                    except Exception:
                                        log.exception("failed to handle server message")
                                elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                                    break
                                if reconnect_task.done():
                                    break
                        finally:
                            reconnect_task.cancel()
                        if ws.close_code and ws.close_code >= 4000:
                            self.server_error = f"Server hat die Verbindung abgelehnt ({ws.close_code})"
                except Exception as err:
                    self.server_error = f"Server nicht erreichbar: {err}"
                    log.warning("server connection failed: %s", err)
                finally:
                    self.ws = None
                    self.connected = False
                    self.stream["enabled"] = False
                await self._wait_reconnect(backoff)
                backoff = min(backoff * 2, 30)

    async def _wait_reconnect(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self._reconnect.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass
        self._reconnect.clear()

    def request_reconnect(self) -> None:
        self._reconnect.set()
        if self.ws is not None and not self.ws.closed and self.loop is not None:
            self.loop.create_task(self.ws.close())

    async def handle(self, msg: dict) -> None:
        t = msg.get("type")
        if t == "welcome":
            self.claimed = bool(msg.get("claimed"))
            self.pairing_code = msg.get("pairingCode")
            self.board_name = msg.get("name")
            if self.pairing_code:
                log.info("=== Kopplungscode: %s ===  (in der Web-App unter Boards > Board hinzufügen eingeben)", self.pairing_code)
            else:
                log.info("Board ist mit einem Konto verbunden (%s)", self.board_name)
            await self.send_status(force=True)
        elif t == "stream":
            self.stream = {"enabled": bool(msg.get("enabled")), "fps": float(msg.get("fps", 4)), "maxWidth": int(msg.get("maxWidth", 640))}
        elif t == "snapshot_request":
            cam = self.cameras.by_index(int(msg.get("camera", 0)))
            data, w, h = None, 0, 0
            if cam is not None:
                _, frame = cam.latest()
                if frame is not None:
                    data, w, h = await asyncio.to_thread(encode_jpeg, frame, None, 90)
            await self.send({"type": "snapshot", "requestId": msg.get("requestId"), "camera": int(msg.get("camera", 0)), "data": data, "width": w, "height": h})
        elif t == "set_calibration":
            cam = self.cameras.by_index(int(msg.get("camera", -1)))
            if cam is None:
                return
            cal = msg.get("calibration")
            if cal and len(cal.get("points", [])) == 5:
                self.store.calibration[cam.cam_id] = {"points": [[float(p["x"]), float(p["y"])] for p in cal["points"]]}
            else:
                self.store.calibration.pop(cam.cam_id, None)
            self.store.save_calibration()
            self.apply_calibration()
            self.detector.reset()
            await self.send({"type": "calibration", "calibration": self.calibration_by_index()})
            await self.send_status(force=True)
        elif t == "command":
            await self.command(msg.get("action", ""))
        elif t == "set_settings":
            old = (list(self.store.settings.resolution), self.store.settings.fps)
            self.store.settings.update(msg.get("settings") or {})
            self.store.save_settings()
            if old != (list(self.store.settings.resolution), self.store.settings.fps):
                await asyncio.to_thread(self.start_cameras)
            await self.send({"type": "settings", "settings": self.store.settings.to_dict()})
            await self.send_status(force=True)
        elif t == "ping":
            await self.send({"type": "pong"})
        elif t == "error":
            self.server_error = msg.get("message")
            log.error("server error: %s", self.server_error)

    async def command(self, action: str) -> None:
        if action == "start":
            self.detector.set_detecting(True)
        elif action == "stop":
            self.detector.set_detecting(False)
        elif action == "reset":
            self.detector.reset()
        elif action == "rescan":
            await asyncio.to_thread(self.start_cameras)
            await self.send({"type": "calibration", "calibration": self.calibration_by_index()})
        await self.send_status(force=True)

    # ------------------------------------------------------------------ async workers
    async def event_worker(self) -> None:
        assert self.queue is not None
        while self.running:
            ev = await self.queue.get()
            kind = ev[0]
            if kind == "dart":
                dart = ev[1]
                self.last_dart = {**dart, "label": segment_label(dart["seg"]["number"], dart["seg"]["multiplier"]), "at": time.time()}
                log.info("dart %s at (%.1f, %.1f) cams=%s conf=%.2f", self.last_dart["label"], dart["x"], dart["y"], dart["cameras"], dart["confidence"])
                await self.send({"type": "dart", "dart": dart})
            elif kind in ("takeout_started", "takeout_finished"):
                log.info(kind)
                await self.send({"type": kind})
            await self.send_status()

    async def stream_worker(self) -> None:
        while self.running:
            if self.stream["enabled"] and self.connected:
                start = time.time()
                for s in list(self.cameras.streams):
                    _, frame = s.latest()
                    if frame is None:
                        continue
                    data, w, h = await asyncio.to_thread(encode_jpeg, frame, self.stream["maxWidth"], 70)
                    await self.send({"type": "frame", "camera": s.index, "data": data, "width": w, "height": h})
                await asyncio.sleep(max(0.05, 1 / max(0.5, self.stream["fps"]) - (time.time() - start)))
            else:
                await asyncio.sleep(0.3)

    async def status_worker(self) -> None:
        while self.running:
            await asyncio.sleep(1)
            await self.send_status()
            if int(time.time()) % 10 == 0:
                await self.send_status(force=True)  # keeps fps up to date

    async def run(self) -> None:
        from .webui import start_webui

        self.loop = asyncio.get_running_loop()
        self.queue = asyncio.Queue(maxsize=1000)
        log.info("Autodarter board %s (id %s), camera source: %s", __version__, self.store.board_id, CAMERA_SOURCE)
        await asyncio.to_thread(self.start_cameras)
        threading.Thread(target=self.detection_thread, daemon=True, name="detector").start()
        runner = await start_webui(self)
        try:
            await asyncio.gather(self.server_loop(), self.event_worker(), self.stream_worker(), self.status_worker())
        finally:
            self.running = False
            await runner.cleanup()
            self.cameras.stop()
